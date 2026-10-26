/**
 * 群人际关系网（零依赖）
 *
 * 目的：让机器人在指定群里"认得人、叫得出称呼"。
 *
 * 隐私边界（刻意的）：
 *   - **不存任何消息正文**，只存：成员名/别名、发言次数、@与回复关系、时间戳
 *   - 只对 config 里显式列出的群生效（默认全关）
 *   - 文件权限 600，只在本机；`node relations.mjs clear <gid>` 一键清空
 *
 * 数据模型（.relations.json）：
 * {
 *   "123456789": {
 *     "updatedAt": 1792...,
 *     "members": { "123456": { "card":"老王", "nick":"W", "aliases":{"老王":3}, "msgs":12, "last":1792... } },
 *     "edges":   { "123456>654321": { "mention":2, "reply":1, "last":1792... } },
 *     "msgOwner": { "message_id": {"uid":"123456","at":1792...} }   // 只用于把"回复"连成边，10 分钟过期
 *   }
 * }
 *
 * CLI：
 *   node relations.mjs summary 123456789
 *   node relations.mjs who 123456789 123456
 *   node relations.mjs clear 123456789
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.RELATIONS_PATH || path.join(HERE, '.relations.json');

const LIMITS = {
  maxMembers: 500,
  maxEdges: 5000,
  msgOwnerTtlMs: 600000,   // message_id → 发送者，10 分钟
  memberTtlMs: 90 * 86400000, // 90 天没说话就淡出
};

let DB = null;
let saveTimer = null;

function load() {
  if (DB) return DB;
  try {
    DB = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    DB = {};
  }
  return DB;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = STATE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(DB, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, STATE_PATH);
    } catch (e) {
      console.error('[relations] 保存失败:', String(e?.message || e));
    }
  }, 2000);
}

function group(gid) {
  const db = load();
  const k = String(gid);
  if (!db[k]) db[k] = { updatedAt: Date.now(), members: {}, edges: {}, msgOwner: {} };
  prune(db[k]);
  return db[k];
}

function bumpMember(g, uid, card, nick, ts) {
  const m = g.members[uid] || { card: '', nick: '', aliases: {}, msgs: 0, last: 0 };
  if (card) m.card = card;
  if (nick) m.nick = nick;
  m.msgs += 1;
  m.last = ts;
  g.members[uid] = m;
  // 人数上限：淘汰最久没说话的
  const keys = Object.keys(g.members);
  if (keys.length > LIMITS.maxMembers) {
    keys.sort((a, b) => g.members[a].last - g.members[b].last)
      .slice(0, keys.length - LIMITS.maxMembers)
      .forEach((k) => delete g.members[k]);
  }
  return m;
}

function bumpEdge(g, from, to, kind, ts) {
  if (!from || !to || from === to) return;
  const k = from + '>' + to;
  const e = g.edges[k] || { mention: 0, reply: 0, last: 0 };
  e[kind] = (e[kind] || 0) + 1;
  e.last = ts;
  g.edges[k] = e;
  const keys = Object.keys(g.edges);
  if (keys.length > LIMITS.maxEdges) {
    keys.sort((a, b) => g.edges[a].last - g.edges[b].last)
      .slice(0, keys.length - LIMITS.maxEdges)
      .forEach((x) => delete g.edges[x]);
  }
}

/** 给某个人记一个别名（带频次；过滤掉明显的虚词/超长串） */
const ALIAS_STOP = new Set(['这是', '什么', '这个', '那个', '我们', '你们', '他们', '自己', '一下', '你好']);
const ALIAS_PREFIX = /^(?:这是|是|叫|我|你|他|她|咱|我们|你们|他们)\s*/;
function normalizeAlias(alias) {
  let a = String(alias || '').trim()
    .replace(/^[\s\-—–:：,，。.!！?？]+/, '')
    .replace(/[\s\-—–:：,，。.!！?？]+$/, '')
    .replace(ALIAS_PREFIX, '')
    .trim();
  const chars = Array.from(a);
  if (chars.length < 2 || chars.length > 12) return '';
  if (ALIAS_STOP.has(a)) return '';
  if (/[\s\u0000-\u001f]/.test(a)) return '';
  return a;
}
function removeMember(g, uid) {
  if (!uid || !g.members[uid]) return;
  delete g.members[uid];
  for (const k of Object.keys(g.edges || {})) {
    if (k.startsWith(uid + '>') || k.endsWith('>' + uid)) delete g.edges[k];
  }
}
function prune(g, ts = Date.now()) {
  for (const [uid, m] of Object.entries(g.members || {})) {
    if (m.last && ts - m.last > LIMITS.memberTtlMs) removeMember(g, uid);
  }
  for (const [k, v] of Object.entries(g.msgOwner || {})) {
    if (ts - (v.at || 0) > LIMITS.msgOwnerTtlMs) delete g.msgOwner[k];
  }
}
function setAlias(g, target, alias, selfId) {
  const t = String(target || '');
  if (!t || t === String(selfId || '')) return false;
  if (!g.members[t]) return false; // 不再为未出现的人创建幽灵成员
  const a = normalizeAlias(alias);
  if (!a) return false;
  // 同一别名只归一个人，避免「是三七姐」同时挂在机器人和真人身上
  for (const [uid, m] of Object.entries(g.members)) {
    if (uid !== t && m.aliases && m.aliases[a]) {
      delete m.aliases[a];
      if (m.aliasAt) delete m.aliasAt[a];
      if (m.manualAlias === a) {
        delete m.manualAlias;
        delete m.manualAliasAt;
      }
    }
  }
  const m = g.members[t];
  m.aliases = m.aliases || {};
  m.aliases[a] = Math.min(20, (m.aliases[a] || 0) + 1);
  m.aliasAt = m.aliasAt || {};
  m.aliasAt[a] = Date.now();
  return true;
}

/** 从文本里学称呼：`-这是X` 显式声明、`X哥/老师/总`、`我是/叫我 X` */
function learnAliases(g, uid, text, atTargets, selfId) {
  if (String(uid) === String(selfId || '')) return;
  const m = g.members[uid];
  if (!m) return;
  const s = String(text || '');

  // 关键：先把机器人自己排除。否则「@助手 @老王 -这是大刘」会被当成 @ 了两个人，学不到
  const others = atTargets.filter((x) => x && x !== String(uid) && x !== String(selfId));

  // 同一条消息里同一别名只记一次（否则 `-老王哥` 会被语法①和②各记一遍）
  const pending = new Set();
  const claim = (target, alias) => {
    const k = target + '|' + alias;
    if (pending.has(k)) return;
    pending.add(k);
    setAlias(g, target, alias, selfId);
  };

  // ① 显式声明语法：`@某人 -这是大刘` / `@某人 -大刘`（全角破折号也认）
  //    「-这是X」优先；裸 `-X` 只在 @ 了唯一一个人时生效，且要求是汉字，避免把 `-100` 当名字
  const decl = s.match(/[-—–]\s*(?:这是|是|叫)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,8})/)
    || s.match(/[-—–]\s*([\u4e00-\u9fa5]{2,6})/);
  if (decl && others.length === 1) {
    claim(others[0], decl[1]);
  }

  // ② 别人怎么叫他：`@老三 老王哥你来`
  if (others.length === 1) {
    const hit = s.match(/([\u4e00-\u9fa5]{1,3}(?:哥|姐|叔|姨|总|老师|老板|大佬))/);
    if (hit) claim(others[0], hit[1]);
  }

  // ③ 自我介绍：「我是 X」「叫我 X」
  const self = s.match(/(?:我是|叫我|喊我)\s*([\u4e00-\u9fa5A-Za-z0-9]{1,8})/);
  if (self) claim(uid, self[1]);
}

/**
 * 观察一条群消息（不存正文）
 * @param {{gid:string|number, uid:string|number, card?:string, nick?:string, segs?:Array, text?:string, messageId?:string|number, selfId?:string|number}} ev
 */
export function observe(ev) {
  const gid = ev.gid == null ? null : String(ev.gid);
  const uid = ev.uid == null ? null : String(ev.uid);
  if (!gid || !uid) return;
  const selfId = ev.selfId == null ? '' : String(ev.selfId);
  if (selfId && uid === selfId) return;
  const ts = Date.now();
  const g = group(gid);
  if (selfId) removeMember(g, selfId);
  g.updatedAt = ts;

  const m = bumpMember(g, uid, ev.card || '', ev.nick || '', ts);

  const segs = Array.isArray(ev.segs) ? ev.segs : [];
  const atTargets = segs.filter((s) => s.type === 'at').map((s) => String(s.data?.qq ?? ''));
  const replySeg = segs.find((s) => s.type === 'reply');

  for (const t of atTargets) {
    if (t && t !== String(ev.selfId || '')) bumpEdge(g, uid, t, 'mention', ts);
  }

  // 回复关系：靠 message_id → 发送者 反查
  if (replySeg?.data?.id != null) {
    const ref = g.msgOwner[String(replySeg.data.id)];
    if (ref && ref.uid !== uid) bumpEdge(g, uid, ref.uid, 'reply', ts);
  }

  learnAliases(g, uid, ev.text || '', atTargets, ev.selfId);

  // 记录本条的发送者，供后续"回复"连边（有上限 + TTL）
  if (ev.messageId != null) {
    g.msgOwner[String(ev.messageId)] = { uid, at: ts };
    const ids = Object.keys(g.msgOwner);
    if (ids.length > 500) {
      ids.sort((a, b) => g.msgOwner[a].at - g.msgOwner[b].at)
        .slice(0, ids.length - 500)
        .forEach((k) => delete g.msgOwner[k]);
    }
  }
  for (const [k, v] of Object.entries(g.msgOwner)) {
    if (ts - v.at > LIMITS.msgOwnerTtlMs) delete g.msgOwner[k];
  }

  save();
  return m;
}

/** 取称呼：别名(最高频) > 群名片 > 昵称 */
export function addressFor(gid, uid) {
  const g = load()[String(gid)];
  if (!g) return null;
  const m = g.members[String(uid)];
  if (!m) return null;
  const manual = m.manualAlias ? normalizeAlias(m.manualAlias) : '';
  if (manual && m.aliases && m.aliases[manual]) return manual;
  const aliases = Object.entries(m.aliases || {})
    .map(([a, c]) => [normalizeAlias(a), c, (m.aliasAt && m.aliasAt[a]) || 0])
    .filter(([a]) => a)
    .sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0].localeCompare(b[0]));
  if (aliases.length) return aliases[0][0];
  if (m.card) return m.card;
  if (m.nick) return m.nick;
  return null;
}

/** 某人被谁 @/回复最多、以及他跟谁最熟 */
export function describe(gid, uid) {
  const g = load()[String(gid)];
  if (!g) return null;
  prune(g);
  const u = String(uid);
  const m = g.members[u] || null;
  const out = { uid: u, member: m, outEdges: [], inEdges: [] };
  for (const [k, v] of Object.entries(g.edges)) {
    const [a, b] = k.split('>');
    if (a === u) outEdgesPush(out.outEdges, b, v);
    if (b === u) outEdgesPush(out.inEdges, a, v);
  }
  out.outEdges.sort((x, y) => y.weight - x.weight);
  out.inEdges.sort((x, y) => y.weight - x.weight);
  return out;
}

function outEdgesPush(out, other, v) {
  out.push({ other, weight: (v.mention || 0) + (v.reply || 0), mention: v.mention || 0, reply: v.reply || 0 });
}

/** 文本报告（给 CLI / 排错用） */
export function summary(gid) {
  const g = load()[String(gid)];
  if (!g) return `群 ${gid} 没有任何记录`;
  prune(g);
  const members = Object.entries(g.members).sort((a, b) => b[1].msgs - a[1].msgs);
  const edges = Object.entries(g.edges).sort(
    (a, b) => (b[1].mention + b[1].reply) - (a[1].mention + a[1].reply)
  );
  const nameOf = (uid) => {
    const m = g.members[uid];
    if (!m) return uid;
    const al = Object.entries(m.aliases || {}).sort((x, y) => y[1] - x[1])[0];
    return (al ? al[0] : m.card || m.nick || uid) + '(' + uid + ')';
  };
  const lines = [`群 ${gid}：${members.length} 人，${edges.length} 条关系，更新于 ${new Date(g.updatedAt).toLocaleString()}`];
  lines.push('\n— 活跃成员 —');
  for (const [uid, m] of members.slice(0, 12)) {
    const al = Object.entries(m.aliases || {}).map(([k, v]) => `${k}×${v}`).join('、');
    lines.push(`  ${nameOf(uid)}  发言 ${m.msgs}${al ? '  别名: ' + al : ''}`);
  }
  lines.push('\n— 关系最强 —');
  for (const [k, v] of edges.slice(0, 12)) {
    const [a, b] = k.split('>');
    lines.push(`  ${nameOf(a)} → ${nameOf(b)}   @${v.mention || 0} 回复${v.reply || 0}`);
  }
  return lines.join('\n');
}

/** 清空某个群（隐私开关） */
export function clear(gid) {
  const db = load();
  delete db[String(gid)];
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(db, null, 1), { mode: 0o600 });
  } catch {}
  return true;
}

/** 是否对该群启用（配置里显式列出才算） */
export function groupEnabled(cfgRelations, gid) {
  if (!cfgRelations?.enabled) return false;
  const groups = cfgRelations.groups || {};
  return Object.prototype.hasOwnProperty.call(groups, String(gid));
}

function persist() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(DB, null, 1), { mode: 0o600 });
  } catch (e) {
    console.error('[relations] 保存失败:', String(e?.message || e));
  }
}

/** 导出完整关系边（给排查/可视化用） */
export function edges(gid) {
  const g = load()[String(gid)];
  if (!g) return [];
  return Object.entries(g.edges || {})
    .map(([k, v]) => {
      const [from, to] = k.split('>');
      return {
        from,
        to,
        mention: v.mention || 0,
        reply: v.reply || 0,
        weight: (v.mention || 0) + (v.reply || 0),
        last: v.last || 0,
      };
    })
    .sort((a, b) => b.weight - a.weight || b.last - a.last);
}

/**
 * 清理一个群的关系数据：
 * - 删除指定 selfId（通常是机器人自己）
 * - 归一化脏别名（去掉「这是/我/你/他/她/叫」等前缀）
 * - 同一别名只保留一个主人（优先发言多、近期使用的人）
 */
export function clean(gid, selfId) {
  const g = load()[String(gid)];
  if (!g) return false;
  if (selfId) removeMember(g, String(selfId));

  for (const m of Object.values(g.members)) {
    const next = {};
    const at = m.aliasAt || {};
    for (const [raw, count] of Object.entries(m.aliases || {})) {
      const a = normalizeAlias(raw);
      if (!a) continue;
      next[a] = Math.min(20, (next[a] || 0) + count);
      if (!at[a] || (at[raw] || 0) > at[a]) at[a] = at[raw] || 0;
    }
    m.aliases = next;
    m.aliasAt = at;
  }

  const owner = new Map();
  for (const [uid, m] of Object.entries(g.members)) {
    for (const a of Object.keys(m.aliases || {})) {
      const prev = owner.get(a);
      if (!prev) { owner.set(a, uid); continue; }
      const pm = g.members[prev];
      const ms = (m.msgs || 0);
      const ps = (pm?.msgs || 0);
      const mt = (m.aliasAt?.[a] || 0);
      const pt = (pm?.aliasAt?.[a] || 0);
      if (ms > ps || (ms === ps && mt > pt)) owner.set(a, uid);
    }
  }
  for (const [uid, m] of Object.entries(g.members)) {
    for (const a of Object.keys(m.aliases || {})) {
      if (owner.get(a) !== uid) delete m.aliases[a];
    }
  }

  persist();
  return true;
}

/** 手动设置称呼：给已存在的成员写别名；同一别名会从其他人身上移除 */
export function setAliasManual(gid, uid, alias) {
  const g = load()[String(gid)];
  if (!g) return false;
  const a = normalizeAlias(alias);
  if (!a) return false;
  if (!setAlias(g, uid, a, '')) return false;
  const m = g.members[String(uid)];
  if (!m) return false;
  m.manualAlias = a;
  m.manualAliasAt = Date.now();
  persist();
  return true;
}

/** 删除某人的某个别名 */
export function forgetAlias(gid, uid, alias) {
  const g = load()[String(gid)];
  if (!g) return false;
  const m = g.members[String(uid)];
  const a = normalizeAlias(alias);
  if (!m || !a || !m.aliases || !m.aliases[a]) return false;
  delete m.aliases[a];
  if (m.aliasAt) delete m.aliasAt[a];
  if (m.manualAlias === a) {
    delete m.manualAlias;
    delete m.manualAliasAt;
  }
  persist();
  return true;
}

/** 按 uid / 别名 / 名片 / 昵称查成员 */
export function find(gid, query) {
  const g = load()[String(gid)];
  if (!g) return [];
  const q = normalizeAlias(query) || String(query || '').trim();
  if (!q) return [];
  const out = [];
  for (const [uid, m] of Object.entries(g.members)) {
    const aliases = Object.keys(m.aliases || {}).map(normalizeAlias).filter(Boolean);
    const names = [String(uid), m.card, m.nick, ...aliases].filter(Boolean);
    if (names.some((n) => n === q || (q.length >= 2 && String(n).includes(q)))) {
      out.push({
        uid,
        name: addressFor(gid, uid) || m.card || m.nick || uid,
        card: m.card || '',
        nick: m.nick || '',
        aliases,
        msgs: m.msgs || 0,
      });
    }
  }
  return out.sort((a, b) => b.msgs - a.msgs);
}

/** 用 reply 的 message_id 反查发送者 */
export function resolveReply(gid, messageId) {
  const g = load()[String(gid)];
  if (!g) return null;
  return g.msgOwner?.[String(messageId)]?.uid || null;
}

// ---------------- CLI ----------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [cmd, gid, uid] = process.argv.slice(2);
  if (cmd === 'summary') console.log(summary(gid));
  else if (cmd === 'who') console.log(JSON.stringify(describe(gid, uid), null, 2));
  else if (cmd === 'clear') console.log(clear(gid) ? `已清空群 ${gid}` : '清空失败');
  else if (cmd === 'edges') console.log(JSON.stringify(edges(gid), null, 2));
  else if (cmd === 'clean') console.log(clean(gid, uid) ? `已清理群 ${gid}` : '清理失败');
  else console.log('用法: node relations.mjs [summary <gid> | who <gid> <uid> | edges <gid> | clean <gid> [selfId] | clear <gid>]');
}
