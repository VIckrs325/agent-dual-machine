#!/usr/bin/env node
/**
 * C 档对账层（档位归属见 ctask/README.md）：跑一次 DSH headless 任务，然后用**代码**复核它的数字答案。
 *
 * 为什么需要：实测发现 4B 会"不执行命令、直接凭印象给数字"，而且不报错、不犹豫
 * （同一任务两次答案 0 / 1）。提示词只能降低概率，代码才能兜住。
 *
 * 做的事：
 *   1. `dsh --profile headless --json` 跑任务，解析 tool_call / tool_result / final
 *   2. 若 final 里有数字：
 *        - 没有 tool_call                → NO_TOOL（凭印象答的）
 *        - grep 类调用 → 用 fs 独立重算   → 与 final 不一致则 MISMATCH
 *   3. 可疑就打回重跑一次（把差异告诉模型），最多 --retries 次
 *   4. 输出 PASS / FIXED / FAIL，并附证据
 *
 * 安全边界：**只对 `grep` 工具做独立复算**（纯 fs 读取，不执行任何 shell）。
 *           bash 类调用只做"数字是否出现在工具输出里"的一致性检查，不重跑，
 *           避免执行模型生成的命令。
 *
 * 用法：
 *   node scripts/task-verify.mjs "统计 ~/qq-bridge.log 里 [llm+search] 的行数，只回答数字"
 *   node scripts/task-verify.mjs "<任务>" --retries 2
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH = process.env.DSH_BIN || 'npx';
const PROFILE = process.env.DSH_PROFILE || 'headless';
const RUN_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 420000);

function parseArgs(argv) {
  const args = argv.slice(2);
  let retries = 1;
  let auditFile = '';
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--retries') retries = Number(args[++i] || 1);
    else if (args[i] === '--audit-only') auditFile = args[++i] || '';
    else rest.push(args[i]);
  }
  return { task: rest.join(' ').trim(), retries, auditFile };
}

/** 把 NDJSON 事件流解析成 {calls, results, final} */
function parseEvents(out) {
  const calls = [];
  const results = new Map();
  let final = '';
  let lastText = '';
  for (const line of out.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    if (ev.type === 'tool_call') calls.push(ev);
    else if (ev.type === 'tool_result') results.set(ev.callId, ev);
    else if (ev.type === 'text') lastText = ev.text || lastText;
    else if (ev.type === 'final') final = ev.text || final;
  }
  return { calls, results, final: final || lastText };
}

/** 跑一次 headless，返回 {calls, results, final, thinking} */
function runOnce(task) {
  return new Promise((resolve) => {
    const child = spawn(DSH, ['-y', '@deepseek-ai/dsh', '--profile', PROFILE, '--json', task], {
      cwd: os.homedir(),
      env: process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, ...parseEvents(out), err });
    });
  });
}

/** 从文本里抽整数（用于一致性判断） */
function numbers(text) {
  return [...String(text || '').matchAll(/-?\d+/g)].map((m) => Number(m[0]));
}

/** 工具结果是否是失败（失败输出里的数字不能当证据） */
function isFailedResult(res) {
  const s = String(res ?? '');
  return /\[exit code: [1-9]\d*\]/.test(s) || /^\s*error/i.test(s) || /not found|No such file|Permission denied/i.test(s);
}

/** 从任务描述里抽"字面量"（方括号/引号/反引号里的片段），用于独立计数 */
function literalsFromTask(task) {
  const out = new Set();
  for (const re of [/\[([^\[\]\n]{2,40})\]/g, /`([^`\n]{2,40})`/g, /"([^"\n]{2,40})"/g, /'([^'\n]{2,40})'/g, /“([^”\n]{2,40})”/g]) {
    let m;
    while ((m = re.exec(task))) if (m[1].trim()) out.add(m[1].trim());
  }
  return [...out];
}

/**
 * 任务里有「统计/计数/几行」意图 + 字面量时，直接按字面量独立数一遍。
 * 这条能抓住最常见的坑：模型把 [x+y] 写成正则 \[x\+y\]，命令跑出 0。
 */
function literalCounts(task) {
  if (!/(统计|计数|行数|多少行|几次|次数|出现)/.test(task)) return [];
  const lits = literalsFromTask(task);
  if (!lits.length) return [];
  const res = [];
  for (const l of lits) {
    for (const f of guessFiles(task)) {
      try {
        const text = fs.readFileSync(f, 'utf8');
        res.push({ literal: l, file: f, count: text.split('\n').filter((line) => line.includes(l)).length });
      } catch {}
    }
  }
  return res;
}

/** 从任务里猜文件路径（~/ 或 / 开头、带扩展名） */
function guessFiles(task) {
  const found = new Set();
  for (const m of String(task).matchAll(/(~\/[\w.\-\/]+|\/[\w.\-\/]+\.\w+)/g)) {
    let p = m[1];
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    found.add(p);
  }
  return [...found];
}

/** 对 grep 调用做独立复算（纯 fs，不执行 shell） */
function verifyGrep(call) {
  const { pattern, path: p } = call.input || {};
  if (!pattern || !p) return null;
  const target = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  try {
    let re;
    try { re = new RegExp(pattern); } catch { re = new RegExp(pattern.replace(/\\/g, '\\\\')); }
    const text = fs.readFileSync(target, 'utf8');
    const n = text.split('\n').filter((l) => re.test(l)).length;
    return { kind: 'grep', path: target, pattern, actual: n };
  } catch (e) {
    return { kind: 'grep', error: String(e.message || e) };
  }
}

/** 判断这次运行是否可疑；返回 {ok, reason, evidence} */
function audit(run, task) {
  const final = (run.final || '').trim();
  const finalNums = numbers(final);

  if (!final) return { ok: false, reason: 'EMPTY', evidence: '没有最终答案' };

  // ── 判据 1（最强）：任务里有「统计」意图 + 字面量 → 代码按字面量独立数一遍
  const lits = literalCounts(task);
  if (lits.length && finalNums.length) {
    const hit = lits.find((l) => finalNums.includes(l.count));
    if (hit) {
      return {
        ok: true,
        reason: 'LITERAL_VERIFIED',
        evidence: `按字面量「${hit.literal}」在 ${hit.file} 独立计数 = ${hit.count}，与答案一致`,
      };
    }
    const p = lits[0];
    return {
      ok: false,
      reason: 'MISMATCH',
      evidence: `按字面量「${p.literal}」在 ${p.file} 独立计数 = ${p.count}，但答案是 ${finalNums.join(',')}`,
      truth: p.count,
    };
  }

  // ── 判据 2：grep 工具调用 → 用 fs 独立复算
  const greps = run.calls.filter((c) => c.tool === 'grep');
  for (const c of greps) {
    const v = verifyGrep(c);
    if (!v || v.error) continue;
    if (!finalNums.includes(v.actual)) {
      return {
        ok: false,
        reason: 'MISMATCH',
        evidence: `独立复算 grep(/${v.pattern}/ ${v.path}) = ${v.actual}，但答案是 ${finalNums.join(',')}`,
        truth: v.actual,
      };
    }
    return { ok: true, reason: 'GREP_VERIFIED', evidence: `grep 独立复算 = ${v.actual}，与答案一致` };
  }

  // ── 判据 3：有数字但一次工具都没调 → 凭印象答的
  if (finalNums.length > 0 && run.calls.length === 0) {
    return { ok: false, reason: 'NO_TOOL', evidence: `答案含数字 ${finalNums.join(',')}，但没调用任何工具` };
  }

  // ── 判据 4：一致性检查（**只用成功的工具输出**；失败的命令输出不算证据）
  const okResults = [...run.results.values()].filter((r) => !isFailedResult(r.result));
  const failed = [...run.results.values()].filter((r) => isFailedResult(r.result));
  if (finalNums.length > 0) {
    const blob = okResults.map((r) => JSON.stringify(r.result ?? '')).join('\n');
    const toolNums = new Set(numbers(blob));
    const missing = finalNums.filter((n) => !toolNums.has(n));
    if (missing.length) {
      const failedNums = new Set(numbers(failed.map((r) => JSON.stringify(r.result ?? '')).join('\n')));
      const fromFailed = missing.filter((n) => failedNums.has(n));
      return {
        ok: false,
        reason: fromFailed.length ? 'FROM_FAILED_CMD' : 'NOT_IN_TOOL_OUTPUT',
        evidence: fromFailed.length
          ? `答案数字 ${fromFailed.join(',')} 来自失败的命令输出（退出码非 0）`
          : `答案数字 ${missing.join(',')} 未出现在成功的工具输出中`,
      };
    }
    return { ok: true, reason: 'CONSISTENT', evidence: '数字都能在成功的工具输出里找到' };
  }

  return { ok: true, reason: 'NO_NUMERIC', evidence: '结论不含数字，跳过对账' };
}

async function main() {
  const { task, retries, auditFile } = parseArgs(process.argv);

  // 离线对账：给一个已保存的 --json 事件文件，只跑判据（不重新执行任务）
  if (auditFile) {
    let out = '';
    try {
      out = fs.readFileSync(auditFile, 'utf8');
    } catch (e) {
      console.error('读不到事件文件:', String(e.message || e));
      process.exit(2);
    }
    const run = { calls: [], results: new Map(), final: '', ...parseEvents(out) };
    const a = audit(run, task);
    for (const c of run.calls) {
      const r = run.results.get(c.callId);
      console.log(`${c.tool} ${JSON.stringify(c.input).slice(0, 90)}`);
      const res = String(r?.result ?? '').replace(/\n/g, ' ').slice(0, 120);
      if (res) console.log(`  → ${res}`);
    }
    console.log(`答案: ${JSON.stringify((run.final || '').trim().slice(0, 160))}`);
    console.log(`对账: ${a.ok ? '✓' : '✗'} ${a.reason} — ${a.evidence}`);
    process.exit(a.ok ? 0 : 1);
  }

  if (!task) {
    console.error('用法: node task-verify.mjs "任务" [--retries 1]');
    console.error('      node task-verify.mjs "任务" --audit-only /tmp/run.json   # 离线复核已保存的事件');
    process.exit(2);
  }

  const t0 = Date.now();
  let attempt = 0;
  let last = null;

  while (attempt <= retries) {
    attempt++;
    const cur = attempt === 1 ? task : `${task}\n\n【纠正】你上一次的回答是「${last.final}」，但工具的实际结果显示 ${last.truth ?? '与答案不一致'}。请重新执行命令，只按工具的真实输出回答。`;
    console.log(`\n===== 第 ${attempt}/${retries + 1} 次 =====`);
    const run = await runOnce(cur);
    const a = audit(run, cur);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);

    console.log(`工具调用: ${run.calls.length} 次${run.calls.length ? ' → ' + run.calls.map((c) => c.tool).join(',') : ''}`);
    for (const c of run.calls) {
      const r = run.results.get(c.callId);
      const res = String(r?.result ?? '').replace(/\n/g, ' ').slice(0, 120);
      console.log(`  ${c.tool} ${JSON.stringify(c.input).slice(0, 90)}`);
      if (res) console.log(`    → ${res}`);
    }
    console.log(`答案: ${JSON.stringify((run.final || '').trim().slice(0, 160))}`);
    console.log(`对账: ${a.ok ? '✓' : '✗'} ${a.reason} — ${a.evidence}`);
    if (run.err && run.code !== 0) console.log(`stderr: ${run.err.trim().split('\n').slice(-2).join(' | ')}`);

    last = { ...a, final: (run.final || '').trim() };
    if (a.ok) {
      const verdict = attempt === 1 ? 'PASS' : 'FIXED';
      console.log(`\n结论: ${verdict}（${secs}s，第 ${attempt} 次）`);
      process.exit(verdict === 'PASS' ? 0 : 0);
    }
    if (attempt > retries) break;
    console.log('→ 打回重跑（把差异告诉模型）');
  }

  console.log(`\n结论: FAIL（${((Date.now() - t0) / 1000).toFixed(0)}s，${attempt} 次仍未通过）`);
  process.exit(1);
}

main();
