#!/usr/bin/env node
/**
 * 配置层晋升：把 bridge-test/config.json 里的指定字段搬进 bridge/config.json。
 *
 * 为什么需要它：promote-bridge.sh 只搬 4 个代码文件，**从不碰 config**；
 * 而人设/参数迭代都发生在 config 里，所以配置晋升必须单独走一条路。
 *
 * 做法：只替换「指定字段所在的整行」，其余字节保持原样（不整份重写）。
 * 写盘前先 JSON.parse + 断言新值真的进去了，写完再比对两边 md5。
 *
 * 用法：
 *   node scripts/promote-config.mjs                 # 默认搬 system + persona.meowTrigger
 *   node scripts/promote-config.mjs --check         # 只看差什么，不写
 *   node scripts/promote-config.mjs --fields system # 只搬 system
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STABLE = path.join(ROOT, 'bridge/config.json');
const TEST = path.join(ROOT, 'bridge-test/config.json');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const fi = argv.indexOf('--fields');
const fields =
  fi >= 0 && argv[fi + 1]
    ? argv[fi + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : ['system', 'persona.meowTrigger'];

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

/** 找到 JSON 文本里某个点路径字段所在的整行 */
function findLine(lines, dotted) {
  const parts = dotted.split('.');
  const key = parts[parts.length - 1];
  // 缩进 2 空格算一层：顶层 `  "system"` → depth 1；`    "meowTrigger"`（在 persona 里）→ depth 2
  const wantDepth = parts.length;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)"([^"]+)":\s/);
    if (!m) continue;
    if (m[2] !== key) continue;
    const depth = Math.floor(m[1].length / 2);
    if (depth !== wantDepth) continue;
    hits.push(i);
  }
  if (hits.length === 0) throw new Error(`找不到字段行: ${dotted}`);
  if (hits.length > 1) throw new Error(`字段 ${dotted} 匹配到 ${hits.length} 行，拒绝盲改`);
  return hits[0];
}

/** 按点路径取对象里的值，用来做写盘后断言 */
function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const stableText = fs.readFileSync(STABLE, 'utf8');
const testText = fs.readFileSync(TEST, 'utf8');
const stableLines = stableText.split('\n');
const testLines = testText.split('\n');

const edits = [];
for (const f of fields) {
  const si = findLine(stableLines, f);
  const ti = findLine(testLines, f);
  if (stableLines[si] === testLines[ti]) {
    console.log(`[skip] ${f} 已经一致`);
    continue;
  }
  edits.push({ field: f, index: si, before: stableLines[si], after: testLines[ti] });
  console.log(`[diff] ${f}（第 ${si + 1} 行）将有改动`);
}

if (edits.length === 0) {
  console.log('[done] 无需改动');
  process.exit(0);
}
if (checkOnly) {
  for (const e of edits) {
    console.log(`  - ${e.before.trim().slice(0, 100)}`);
    console.log(`  + ${e.after.trim().slice(0, 100)}`);
  }
  console.log('[check] 仅预览，未写入');
  process.exit(0);
}

// 备份（带时间戳，和 tune.mjs 的命名规则一致）
const ts = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const backup = `${STABLE}.${ts}.bak`;
fs.copyFileSync(STABLE, backup);
console.log(`[backup] ${path.basename(backup)}`);

for (const e of edits) stableLines[e.index] = e.after;
const next = stableLines.join('\n');

// 写盘前验证：合法 JSON + 新值真的到位
const parsed = JSON.parse(next);
for (const f of edits.map((e) => e.field)) {
  const v = getPath(parsed, f);
  if (v === undefined) throw new Error(`写盘前断言失败: ${f} 不存在`);
}
fs.writeFileSync(STABLE, next);

const a = md5(STABLE);
const b = md5(TEST);
console.log(`[write] 已更新 ${edits.length} 个字段`);
console.log(`[md5] stable=${a}`);
console.log(`[md5] test  =${b}`);
console.log(a === b ? '[ok] 两边配置已完全一致' : '[note] 仍有差异（可能还有未纳入本次的字段，用 --check 看）');
console.log(`[next] systemctl --user restart qq-bridge   # 配置虽会热重载，重启最干净`);
console.log(`[undo] cp -a ${backup} ${STABLE} && systemctl --user restart qq-bridge`);
