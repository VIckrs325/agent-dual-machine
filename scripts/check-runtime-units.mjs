#!/usr/bin/env node
/**
 * 协作守卫：检查 systemd user unit / drop-in，防止稳定服务被测试线覆盖。
 * 默认只查文件；--runtime 额外核对运行中的 MainPID / ExecStart / DropPaths / 锁文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const home = os.homedir();
const project = path.join(home, '.openclaw/workspace/projects/agent-dual-machine');
const unitPath = path.join(home, '.config/systemd/user/qq-bridge.service');
const dropinDir = unitPath + '.d';
const testUnitPath = path.join(home, '.config/systemd/user/qq-bridge-test.service');
const canonicalPath = path.join(project, 'config/systemd/qq-bridge.service');
const runtime = process.argv.includes('--runtime');
const errors = [];
const warnings = [];

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}
function needLine(text, re, label) {
  if (!re.test(text)) errors.push(label);
}

const unit = read(unitPath);
if (!unit) errors.push('缺少 ' + unitPath);
if (/bridge-test/.test(unit)) errors.push('稳定 unit 仍引用 bridge-test');
needLine(unit, /^WorkingDirectory=%h\/\.openclaw\/workspace\/projects\/agent-dual-machine\/bridge$/m,
  '稳定 unit WorkingDirectory 未指向 bridge/');
needLine(unit, /^ExecStart=\/usr\/bin\/node .*\/projects\/agent-dual-machine\/bridge\/qq-bridge\.mjs$/m,
  '稳定 unit ExecStart 未指向 bridge/qq-bridge.mjs');
needLine(unit, /^ExecStartPre=\/usr\/bin\/node .*\/scripts\/check-bridge-features\.mjs$/m,
  '稳定 unit 缺少 stable feature check');
needLine(unit, /^EnvironmentFile=-?%t\/qq-bridge\.env$/m,
  '稳定 unit 的 EnvironmentFile 未指向 %t/qq-bridge.env（密钥应只放 tmpfs，不落盘）');
if (/^EnvironmentFile=%h\/\.config\/qq-bridge\.env$/m.test(unit)) {
  errors.push('稳定 unit 仍在用 ~/.config/qq-bridge.env（密钥会落盘，应改为 %t/qq-bridge.env）');
}
// 缺缓存时必须能被看见、且不能无限重试
needLine(unit, /^ExecStartPre=\/bin\/sh -c '.*qq-bridge\.env.*exit 78.*'$/m,
  '稳定 unit 缺少"缓存缺失即退出 78"的前置守卫');
needLine(unit, /^RestartPreventExitStatus=78$/m, '稳定 unit 缺少 RestartPreventExitStatus=78');
needLine(unit, /^StartLimitBurst=\d+$/m, '稳定 unit 缺少 StartLimitBurst（Restart=always 会无限重试）');

let activeDropins = [];
try {
  activeDropins = fs.readdirSync(dropinDir).filter((f) => f.endsWith('.conf'));
} catch {}
if (activeDropins.length) {
  errors.push('存在 active drop-in: ' + activeDropins.join(', ') + '（应改名为 .disabled）');
}

const canonical = read(canonicalPath);
if (!canonical) {
  warnings.push('缺少 canonical unit: ' + canonicalPath);
} else {
  if (/bridge-test/.test(canonical)) errors.push('canonical unit 引用了 bridge-test');
  needLine(canonical, /^ExecStart=\/usr\/bin\/node .*\/bridge\/qq-bridge\.mjs$/m,
    'canonical unit ExecStart 未指向 bridge/');
}

const testUnit = read(testUnitPath);
if (testUnit) {
  if (!/^WorkingDirectory=.*\/bridge-test$/m.test(testUnit)) warnings.push('测试 unit WorkingDirectory 不是 bridge-test');
  if (!/^Environment=SHADOW=1$/m.test(testUnit)) errors.push('测试 unit 缺少 Environment=SHADOW=1');
}

if (runtime) {
  try {
    const show = execFileSync('systemctl', ['--user', 'show', 'qq-bridge', '-p', 'MainPID', '-p', 'ExecStart', '-p', 'DropInPaths'], { encoding: 'utf8' });
    const mainPid = (show.match(/^MainPID=(\d+)$/m) || [])[1] || '';
    const execLine = (show.match(/^ExecStart=.*$/m) || [''])[0];
    const dropLine = (show.match(/^DropInPaths=(.*)$/m) || [])[1] || '';
    if (!/\/bridge\/qq-bridge\.mjs/.test(execLine) || /bridge-test/.test(execLine)) {
      errors.push('运行中的 stable ExecStart 不是 bridge/qq-bridge.mjs');
    }
    if (dropLine.trim()) errors.push('运行中的 stable 仍有 drop-in: ' + dropLine);
    // 锁文件有两种格式：2026-10-22 起是 JSON（pid/startedAt/systemd/cmd），之前是纯 pid 文本。
    // 这里都要认，否则改格式会把版本管理的准入校验卡死。
    const rawLock = read(path.join(project, 'bridge/.bridge.pid')).trim();
    let lockPid = rawLock;
    try {
      const j = JSON.parse(rawLock);
      if (j && j.pid) lockPid = String(j.pid);
    } catch {
      /* 旧格式：纯 pid 文本，原样比对 */
    }
    if (!mainPid) errors.push('stable MainPID 为空');
    else if (lockPid !== mainPid) errors.push('stable 锁文件 ' + (rawLock || 'none') + ' != MainPID ' + mainPid);
    let testActive = '';
    try { testActive = execFileSync('systemctl', ['--user', 'is-active', 'qq-bridge-test'], { encoding: 'utf8' }).trim(); } catch {}
    if (testActive === 'active') warnings.push('测试服务正在运行（应确认 SHADOW=1）');
  } catch (e) {
    errors.push('runtime check 失败: ' + String(e.message || e));
  }
}

if (warnings.length) for (const w of warnings) console.error('[warn] ' + w);
if (errors.length) {
  for (const e of errors) console.error('[fail] ' + e);
  process.exit(1);
}
console.log('[units] OK' + (runtime ? ' (runtime)' : ''));
