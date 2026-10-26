#!/usr/bin/env node
/**
 * 密钥推送 / 撤销（L1：密钥只放 tmpfs，不落盘）
 *
 * 设计前提
 *   - 真密钥只有 ONEBOT_TOKEN 与 TAVILY_API_KEY 两个（ONEBOT_WS 不算密钥）。
 *   - vault 放在**项目目录之外**（默认 ~/.secrets/qq-bridge.env），物理上不可能被 git 提交。
 *   - 算力端只收进 /run/user/<uid>/qq-bridge.env（tmpfs，内存）。机器重启即清空，
 *     systemd 找不到 EnvironmentFile 会直接 failed —— 没有显式授权就不上线。
 *
 * 用法
 *   node scripts/secrets.mjs status --host user@host      # 看远端缓存与服务状态
 *   node scripts/secrets.mjs push   --host user@host      # vault -> 远端 tmpfs + 重启服务
 *   node scripts/secrets.mjs push   --host user@host --dry-run   # 只校验 vault，不推送
 *   node scripts/secrets.mjs revoke --host user@host      # 删远端缓存 + 停服务
 *   node scripts/secrets.mjs pull   --host user@host      # 从远端旧位置迁移一份进 vault
 *   node scripts/secrets.mjs show                          # 只打印本地 vault 的键名/长度
 *
 * 环境变量（都可被 flag 覆盖）
 *   QQ_HOST   远端 ssh 目标，如 user@192.168.1.10
 *   QQ_VAULT  vault 路径，默认 ~/.secrets/qq-bridge.env
 *
 * 安全约定
 *   - 任何子命令都**不打印值**，只打印键名与长度。
 *   - vault 与远端缓存的权限都必须是 600；push 时用 umask 077 写入。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RUNTIME_NAME = 'qq-bridge.env';
const KEY_RE = /^[A-Z_][A-Z0-9_]*=/;

const args = process.argv.slice(2);
const cmd = args[0] || '';
const flag = (name, def = '') => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return !v || v.startsWith('--') ? 'true' : v;
};
const has = (name) => args.includes('--' + name);

const HOST = flag('host') || process.env.QQ_HOST || '';
const VAULT = flag('vault') || process.env.QQ_VAULT || path.join(os.homedir(), '.secrets', RUNTIME_NAME);

function die(msg, code = 1) {
  console.error('[err] ' + msg);
  process.exit(code);
}

/** 跑远端命令。不经过本地 shell（argv 直传），避免引号被本机吃掉。 */
function ssh(script, { input } = {}) {
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=8', HOST, script], {
    input,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.error) die('ssh 调用失败：' + r.error.message + '（检查 OpenSSH 是否在 PATH 里）');
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function needHost() {
  if (!HOST) die('缺少 --host（或环境变量 QQ_HOST），例如：--host user@192.168.1.10');
}

/** 读 vault 并做格式校验。返回 { lines, summary } —— 绝不返回给用户看的明文。 */
function readVault() {
  if (!fs.existsSync(VAULT)) {
    die(`vault 不存在：${VAULT}\n      先用一次性迁移拉一份：node scripts/secrets.mjs pull --host ...`);
  }
  const raw = fs.readFileSync(VAULT, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const bad = lines.filter((l) => !KEY_RE.test(l));
  if (bad.length) die(`vault 有 ${bad.length} 行不是 KEY=VALUE 格式，已中止`);
  const empty = lines.filter((l) => !l.split('=').slice(1).join('=').trim());
  if (empty.length) die(`vault 中这些键的值为空：${empty.map((l) => l.split('=')[0]).join(', ')}`);
  const summary = lines
    .map((l) => {
      const i = l.indexOf('=');
      return `${l.slice(0, i)}=${'*'.repeat(Math.min(l.length - i - 1, 8))} (${l.length - i - 1} 字符)`;
    })
    .join('\n        ');
  return { text: lines.join('\n') + '\n', summary, keys: lines.map((l) => l.split('=')[0]) };
}

function remotePath() {
  return '"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/' + RUNTIME_NAME + '"';
}

function describeVault() {
  const st = fs.statSync(VAULT);
  if (process.platform === 'win32') {
    // Windows 上 chmod 不生效，权限靠 ACL；这里只报大小，别误导成 666
    return `${VAULT}  (${st.size} 字节, 权限请用 icacls 核对)`;
  }
  const mode = (st.mode & 0o777).toString(8);
  const warn = mode === '600' ? '' : '  ← 建议 chmod 600';
  return `${VAULT}  (${st.size} 字节, 权限 ${mode})${warn}`;
}

// ---------------------------------------------------------------- 子命令

function cmdShow() {
  const v = readVault();
  console.log('vault : ' + describeVault());
  console.log('键    : ' + v.keys.join(', '));
  console.log('内容  :\n        ' + v.summary);
}

function cmdStatus() {
  needHost();
  // 注意：必须用换行拼接，不能用 ";" —— `if ... then;` 在 bash 里是语法错误
  const script = [
    'set -u',
    'R="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'F="$R/' + RUNTIME_NAME + '"',
    'if [ -f "$F" ]; then',
    '  echo "cache=present"',
    '  stat -c "cache_mode=%a cache_owner=%U cache_size=%s cache_mtime=%y" "$F"',
    'else',
    '  echo "cache=absent"',
    'fi',
    'echo "svc=$(systemctl --user is-active qq-bridge 2>/dev/null || true)"',
    // 属性名是 EnvironmentFiles（复数、数组），单数 EnvironmentFile 拿不到值
    'echo "unit=$(systemctl --user show qq-bridge -p EnvironmentFiles --value 2>/dev/null || true)"',
    'echo "linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"',
  ].join('\n');
  const r = ssh(script);
  console.log(`[status] ${HOST}`);
  console.log(r.out || '(无输出)');
  if (r.err) console.log('[stderr] ' + r.err);

  const cacheOk = /cache=present/.test(r.out) && /cache_mode=600/.test(r.out);
  const svcOk = /svc=active/.test(r.out);
  const unitOk = /unit=\/run\/user\/\d+\/qq-bridge\.env/.test(r.out);
  console.log('---');
  console.log(`缓存文件 600 : ${cacheOk ? 'OK' : 'NG（需 push）'}`);
  console.log(`unit 指向 tmpfs : ${unitOk ? 'OK' : 'NG（若刚改过 unit，先 daemon-reload 并装新 unit）'}`);
  console.log(`服务 active : ${svcOk ? 'OK' : 'NG（重启后正常：需重新 push 才会起来）'}`);
  process.exit(cacheOk && svcOk && unitOk ? 0 : 1);
}

function cmdPush() {
  needHost();
  const v = readVault();
  console.log('vault : ' + describeVault());
  console.log('推送  :\n        ' + v.summary);
  if (has('dry-run')) {
    console.log('[dry-run] 只校验，未推送。');
    return;
  }

  const writeScript = [
    'set -e',
    'R="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'F="$R/' + RUNTIME_NAME + '"',
    'mkdir -p "$R"',
    'umask 077',
    'cat > "$F"',
    'chmod 600 "$F"',
    'stat -c "written mode=%a owner=%U size=%s" "$F"',
  ].join('; ');
  const w = ssh(writeScript, { input: v.text });
  if (w.code !== 0) die('写入远端失败：' + (w.err || w.out));
  console.log('[push] ' + w.out);

  if (has('no-restart')) {
    console.log('[push] 已写入缓存，按要求未重启服务。');
    return;
  }
  // 缓存缺失时 unit 会连试 3 次后停在 failed（StartLimitBurst），
  // 这种状态下 restart 会被拒绝，必须先 reset-failed。
  const rs = ssh('systemctl --user reset-failed qq-bridge 2>/dev/null; systemctl --user restart qq-bridge; sleep 3; systemctl --user is-active qq-bridge');
  const state = (rs.out || rs.err || '').trim();
  console.log('[push] 服务状态：' + state);
  if (state !== 'active') die('服务未进入 active，查日志：journalctl --user -u qq-bridge -n 40', 2);

  const logs = ssh("journalctl --user -u qq-bridge --no-pager -n 30 | grep -E '\\[cfg\\]|OneBot|已连接' | tail -4");
  if (logs.out) console.log('[push] 日志：\n' + logs.out.split('\n').map((l) => '        ' + l).join('\n'));
  console.log('[push] 完成。密钥只在 tmpfs，重启后需重新 push。');
}

function cmdRevoke() {
  needHost();
  const script = [
    'R="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'F="$R/' + RUNTIME_NAME + '"',
    'if [ -f "$F" ]; then rm -f "$F" && echo "cache=removed"; else echo "cache=already-absent"; fi',
    'systemctl --user stop qq-bridge 2>/dev/null || true',
    'echo "svc=$(systemctl --user is-active qq-bridge 2>/dev/null || true)"',
  ].join('; ');
  const r = ssh(script);
  console.log(`[revoke] ${HOST}`);
  console.log(r.out || '(无输出)');
  console.log('[revoke] 缓存已清除、服务已停。恢复上线：node scripts/secrets.mjs push --host ' + HOST);
}

/** 一次性迁移：从远端旧位置把明文密钥拉进 vault，之后建议删掉远端旧文件。 */
function cmdPull() {
  needHost();
  if (fs.existsSync(VAULT) && !has('force')) {
    die(`vault 已存在：${VAULT}\n      确认要覆盖就加 --force（会先备份成 .bak-<时间戳>）`);
  }
  const r = ssh('cat ~/.config/qq-bridge.env 2>/dev/null || echo __NONE__');
  if (!r.out || r.out === '__NONE__') die('远端 ~/.config/qq-bridge.env 不存在，无可迁移内容');
  const lines = r.out.split(/\r?\n/).filter((l) => l && KEY_RE.test(l));
  if (!lines.length) die('远端文件里没有可识别的 KEY=VALUE');

  fs.mkdirSync(path.dirname(VAULT), { recursive: true, mode: 0o700 });
  if (fs.existsSync(VAULT)) {
    const bak = VAULT + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(VAULT, bak);
    console.log('[pull] 旧 vault 已备份到 ' + bak);
  }
  fs.writeFileSync(VAULT, lines.join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(VAULT, 0o600); } catch {}
  console.log('[pull] 已写入 vault：' + describeVault());
  console.log('[pull] 键：' + lines.map((l) => l.split('=')[0]).join(', '));
  console.log('[pull] 下一步：node scripts/secrets.mjs push --host ' + HOST);
  console.log('[pull] 确认 push 成功后，删掉远端旧文件：');
  console.log("       ssh " + HOST + " 'shred -u ~/.config/qq-bridge.env 2>/dev/null || rm -f ~/.config/qq-bridge.env'");
}

// ---------------------------------------------------------------- 入口

const HELP = `用法: node scripts/secrets.mjs <status|push|revoke|pull|show> [--host user@host] [--vault 路径]

  status   查看远端 tmpfs 缓存是否存在、权限、服务状态
  push     vault -> 远端 tmpfs（600），然后重启并校验服务
  revoke   删远端缓存 + 停服务（下发即下线）
  pull     从远端旧位置 ~/.config/qq-bridge.env 迁移一份进 vault
  show     只打印本地 vault 的键名与长度（不出网）

  --dry-run     push 时只校验 vault，不发送
  --no-restart  push 后不重启服务
  --force       pull 时覆盖已存在的 vault`;

switch (cmd) {
  case 'show': cmdShow(); break;
  case 'status': cmdStatus(); break;
  case 'push': cmdPush(); break;
  case 'revoke': cmdRevoke(); break;
  case 'pull': cmdPull(); break;
  case '':
  case '-h':
  case '--help':
    console.log(HELP); break;
  default:
    die('未知子命令：' + cmd + '\n\n' + HELP);
}
