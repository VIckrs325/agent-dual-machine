#!/usr/bin/env node
/**
 * file-guard —— 多 agent 共写同一批文件时的"指纹守卫"
 *
 * 解决什么问题：我和 OpenClaw 都会改 docs/bridge/config，谁都能整份重写，
 * 结果静默覆盖对方的改动（真实发生过：桥重写丢了两个环境变量）。
 *
 * 用法：
 *   node scripts/file-guard.mjs check            # 全量比对，有漂移退出码 1
 *   node scripts/file-guard.mjs check bridge/search.mjs   # 单文件：CLEAN / DRIFT / UNTRACKED
 *   node scripts/file-guard.mjs stamp --by workbuddy      # 收工盖章，更新基线
 *   node scripts/file-guard.mjs list              # 列出基线里记录的文件
 *
 * 判定基于内容哈希（sha256），不是 mtime —— touch 不算改动。
 * 运行时文件（.state.json / .bridge.pid / *.log）不入账。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MANIFEST = path.join(ROOT, '.file-manifest.json');

const TRACK_DIRS = ['docs', 'bridge', 'scripts', 'config', 'btask', 'ctask'];
const TRACK_ROOT_FILES = ['README.md', 'HANDOVER.md', 'CHANGELOG.md'];
const SKIP_NAMES = new Set(['.bridge.pid', '.file-manifest.json']);
// 运行时数据文件（含备份）：群成员/会话存档，带个人数据，绝不进版本指纹
const SKIP_PREFIX = ['.state.json', '.relations.'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'traces']);
const SKIP_EXT = new Set(['.log', '.jsonl']); // .jsonl = 评测/轨迹类运行时数据

function shouldTrack(rel) {
  const base = path.basename(rel);
  if (SKIP_NAMES.has(base)) return false;
  if (SKIP_PREFIX.some((p) => base.startsWith(p))) return false;
  if (SKIP_EXT.has(path.extname(base))) return false;
  return true;
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else {
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (shouldTrack(rel)) out.push(rel);
    }
  }
  return out;
}

function trackedFiles() {
  const list = [];
  for (const d of TRACK_DIRS) {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full)) walk(full, list);
  }
  for (const f of TRACK_ROOT_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) list.push(f);
  }
  return [...new Set(list)].sort();
}

function sha(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return { version: 1, files: {} };
  }
}

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stamp(by) {
  const m = { version: 1, updatedAt: new Date().toISOString(), by, files: {} };
  const files = trackedFiles();
  for (const rel of files) {
    const full = path.join(ROOT, rel);
    const st = fs.statSync(full);
    m.files[rel] = {
      sha: sha(full),
      size: st.size,
      mtime: st.mtime.toISOString(),
      by,
      at: m.updatedAt,
    };
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  console.log(`[stamp] 已记录 ${files.length} 个文件的指纹 → ${path.relative(ROOT, MANIFEST)}`);
  console.log(`[stamp] 记录人: ${by}`);
}

function checkOne(rel, m) {
  const full = path.join(ROOT, rel);
  const cur = sha(full);
  if (cur === null) return { rel, status: 'MISSING', rec: m.files[rel] || null };
  const rec = m.files[rel];
  if (!rec) return { rel, status: 'UNTRACKED', cur, rec: null };
  return { rel, status: rec.sha === cur ? 'CLEAN' : 'DRIFT', cur, rec };
}

function cmdCheck(targets) {
  const m = readManifest();
  const baseAt = m.updatedAt;

  if (targets.length) {
    // 单文件模式：给 agent 用的判断口径
    let bad = 0;
    for (const t of targets) {
      const rel = path.relative(ROOT, path.resolve(ROOT, t)).split(path.sep).join('/');
      const r = checkOne(rel, m);
      if (r.status === 'CLEAN') {
        console.log(`CLEAN      ${rel}（与 ${fmtTime(r.rec.at)} 的基线一致，${r.rec.by} 记录）`);
      } else if (r.status === 'DRIFT') {
        bad++;
        console.log(`DRIFT      ${rel}`);
        console.log(`           基线 ${r.rec.sha} @ ${fmtTime(r.rec.at)} by ${r.rec.by}`);
        console.log(`           当前 ${r.cur}`);
        console.log('           → 有人改过。先读最新内容，用合并/增量方式改，禁止整份覆盖。');
      } else if (r.status === 'UNTRACKED') {
        console.log(`UNTRACKED  ${rel}（基线里没有它，新增文件可放心写）`);
      } else {
        bad++;
        console.log(`MISSING    ${rel}（文件不存在）`);
      }
    }
    process.exit(bad ? 1 : 0);
  }

  // 全量模式
  const files = trackedFiles();
  const changed = [];
  const added = [];
  const missing = [];
  for (const rel of files) {
    const r = checkOne(rel, m);
    if (r.status === 'DRIFT') changed.push(r);
    else if (r.status === 'UNTRACKED') added.push(rel);
  }
  for (const rel of Object.keys(m.files)) {
    if (!fs.existsSync(path.join(ROOT, rel))) missing.push(rel);
  }

  console.log(`[check] 基线 ${fmtTime(baseAt)} by ${m.by || '?'} ｜ 共 ${Object.keys(m.files).length} 个文件`);
  if (changed.length) {
    console.log(`\n[!] 内容被改过（${changed.length}）：`);
    for (const r of changed) console.log(`    ${r.rel}   ${r.rec.sha} → ${r.cur}`);
  }
  if (added.length) {
    console.log(`\n[+] 基线之后新增（${added.length}）：`);
    for (const a of added) console.log(`    ${a}`);
  }
  if (missing.length) {
    console.log(`\n[-] 已删除（${missing.length}）：`);
    for (const d of missing) console.log(`    ${d}`);
  }
  if (!changed.length && !added.length && !missing.length) {
    console.log('\n[✓] 与基线完全一致');
    process.exit(0);
  }
  console.log('\n下一步：看 CHANGELOG.md 的「进行中」是否有人认领；确认后合并改动，最后 stamp。');
  process.exit(changed.length || missing.length ? 1 : 0);
}

function cmdList() {
  const m = readManifest();
  const rows = Object.entries(m.files).sort(([a], [b]) => a.localeCompare(b));
  console.log(`基线更新时间: ${fmtTime(m.updatedAt)} by ${m.by || '?'}`);
  for (const [rel, r] of rows) console.log(`  ${r.sha}  ${fmtTime(r.at)}  ${rel}`);
}

// ---- 入口 ----
const argv = process.argv.slice(2);
const cmd = argv[0] || 'check';
let by = process.env.AGENT_NAME || 'unknown';
const bIdx = argv.indexOf('--by');
if (bIdx >= 0 && argv[bIdx + 1]) by = argv[bIdx + 1];
const targets = argv.slice(1).filter((a, i) => a !== '--by' && argv[i] !== '--by');

if (cmd === 'stamp') stamp(by);
else if (cmd === 'check') cmdCheck(targets);
else if (cmd === 'list') cmdList();
else {
  console.error('用法: node scripts/file-guard.mjs [check [文件...] | stamp --by <名字> | list]');
  process.exit(2);
}
