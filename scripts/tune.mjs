#!/usr/bin/env node
/**
 * 改桥配置的小工具（只改一个字段，不整份重写）
 *
 * 用法：
 *   node scripts/tune.mjs groupEngagement.windowMs 180000
 *   node scripts/tune.mjs groupEngagement.maxReplies 4
 *   node scripts/tune.mjs groupEngagement.randomChance 0.5
 *   node scripts/tune.mjs search.enabled true
 *   node scripts/tune.mjs relations.enabled false
 *   node scripts/tune.mjs --list                  # 看当前关键配置
 *   node scripts/tune.mjs --test ...              # 改测试版（bridge-test/config.json）
 *
 * 说明：
 *   - 改完自动热重载（桥在监听 config.json），不需要重启
 *   - 备份成带时间戳的 config.json.YYYYMMDDHHMMSS.bak，自动保留最近 KEEP_BACKUPS 份
 *     （早于本改动的旧 config.json.bak 不会被删，留作人工参考）
 *   - 值类型按原值推断：原来是数字就转数字，原来是布尔就转 true/false
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const useTest = argv.includes('--test');
const cfgPath = path.join(ROOT, useTest ? 'bridge-test' : 'bridge', 'config.json');

const KEY_VIEW = [
  'groupEngagement.enabled',
  'groupEngagement.windowMs',
  'groupEngagement.quotaWindowMs',
  'groupEngagement.maxReplies',
  'groupEngagement.minIntervalMs',
  'groupEngagement.randomChance',
  'groupEngagement.questionOnly',
  'persona.enabled',
  'search.enabled',
  'search.provider',
  'relations.enabled',
  'relations.nl',
  'model',
  'maxChars',
];

function readCfg() {
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function set(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function coerce(oldValue, raw) {
  if (typeof oldValue === 'boolean') {
    if (/^(true|1|on|yes|开)$/i.test(raw)) return true;
    if (/^(false|0|off|no|关)$/i.test(raw)) return false;
    throw new Error(`需要布尔值（true/false），收到：${raw}`);
  }
  if (typeof oldValue === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`需要数字，收到：${raw}`);
    return n;
  }
  return raw;
}

const cfg = readCfg();

if (argv.includes('--list') || argv.length === 0) {
  console.log(`配置文件：${cfgPath}`);
  console.log('---');
  for (const k of KEY_VIEW) {
    const v = get(cfg, k);
    if (v !== undefined) console.log(`${k.padEnd(34)} = ${JSON.stringify(v)}`);
  }
  console.log('\n用法示例：node scripts/tune.mjs groupEngagement.windowMs 180000');
  process.exit(0);
}

const [dotted, raw] = argv.filter((a) => !a.startsWith('--'));
if (!dotted || raw === undefined) {
  console.error('用法：node scripts/tune.mjs <配置路径> <新值>');
  process.exit(2);
}

const oldValue = get(cfg, dotted);
if (oldValue === undefined) {
  console.error(`找不到配置项：${dotted}`);
  console.error('可用 --list 查看支持的关键项；也可以是任意已存在的字段路径。');
  process.exit(2);
}

let value;
try {
  value = coerce(oldValue, raw);
} catch (e) {
  console.error(String(e.message || e));
  process.exit(2);
}

if (JSON.stringify(oldValue) === JSON.stringify(value)) {
  console.log(`无需修改：${dotted} 已经是 ${JSON.stringify(value)}`);
  process.exit(0);
}

// 备份带时间戳：以前固定写 config.json.bak，连改两次就把中间态覆盖没了。
// 只清理本工具产生、且命名严格匹配的旧备份；旧的 config.json.bak 不动。
const KEEP_BACKUPS = 20;
const p2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const stamp =
  `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
  `${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
const backup = `${cfgPath}.${stamp}.bak`;
fs.copyFileSync(cfgPath, backup);

const cfgDir = path.dirname(cfgPath);
const cfgBase = path.basename(cfgPath);
const backupRe = new RegExp(
  `^${cfgBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{14}\\.bak$`,
);
const olds = fs.readdirSync(cfgDir).filter((f) => backupRe.test(f)).sort();
const dropped = olds.slice(0, Math.max(0, olds.length - KEEP_BACKUPS));
for (const f of dropped) {
  try {
    fs.unlinkSync(path.join(cfgDir, f));
  } catch {
    /* 删不掉就算了，不影响本次修改 */
  }
}

set(cfg, dotted, value);
const tmp = cfgPath + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
fs.renameSync(tmp, cfgPath);

console.log(`[tune] ${useTest ? '测试版' : '稳定版'} ${dotted}: ${JSON.stringify(oldValue)} → ${JSON.stringify(value)}`);
console.log(`[tune] 已备份 ${path.basename(backup)}${dropped.length ? `（清理旧备份 ${dropped.length} 份）` : ''}`);
console.log('[tune] 桥会在 1~2 秒内热重载；用 node scripts/ctl.sh status 确认');
