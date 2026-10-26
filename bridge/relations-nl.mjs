/**
 * 关系网自然语言入口（趣味向，所有人可写）
 * 只在私聊或被 @ 时触发；群里普通聊天不解析。
 */
import * as rel from './relations.mjs';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function atUids(segs, selfId) {
  return (Array.isArray(segs) ? segs : [])
    .filter((s) => s.type === 'at')
    .map((s) => String(s.data?.qq ?? ''))
    .filter((q) => q && q !== String(selfId));
}

function one(list, label) {
  if (!list.length) return { error: '没找到' + (label ? '「' + label + '」' : '对应的人') };
  if (list.length > 1) {
    return {
      error: '有多个匹配：' + list.slice(0, 4).map((x) => x.name + '(' + x.uid + ')').join('、') + '，请用 @ 指定',
    };
  }
  return { member: list[0] };
}

function byName(gid, q) {
  return one(rel.find(gid, q), q);
}

function targetOf({ gid, uid, segs, selfId, name, pronoun }) {
  const ats = atUids(segs, selfId);
  if (ats.length === 1) {
    const m = rel.find(gid, ats[0])[0];
    return { member: m || { uid: ats[0], name: ats[0], aliases: [], msgs: 0 } };
  }
  if (pronoun === '我') {
    return { member: rel.find(gid, uid)[0] || { uid: String(uid), name: String(uid), aliases: [], msgs: 0 } };
  }
  if (pronoun === '你') {
    return { member: rel.find(gid, selfId)[0] || { uid: String(selfId), name: '我', aliases: [], msgs: 0 } };
  }
  if (name) return byName(gid, name);
  const reply = (Array.isArray(segs) ? segs : []).find((s) => s.type === 'reply');
  if (reply?.data?.id != null) {
    const ruid = rel.resolveReply(gid, reply.data.id);
    if (ruid) {
      const m = rel.find(gid, ruid)[0];
      return { member: m || { uid: ruid, name: ruid, aliases: [], msgs: 0 } };
    }
  }
  return { error: '你说的是谁？@ 一下或引用他的消息' };
}

function fmtWho(gid, uid) {
  const d = rel.describe(gid, uid);
  if (!d) return '没找到这个人';
  const m = d.member || {};
  const name = rel.addressFor(gid, uid) || m.card || m.nick || uid;
  const al = Object.entries(m.aliases || {}).map(([a, c]) => a + '×' + c).join('、');
  const top = (list) => (list || []).slice(0, 3).map((x) => {
    const other = rel.addressFor(gid, x.other) || x.other;
    return other + '(' + x.other + ') ' + x.weight;
  }).join('；');
  const out = [name + '(' + uid + ')' + (al ? ' 别名：' + al : ''), '发言：' + (m.msgs || 0)];
  if (d.outEdges?.length) out.push('他联系最多：' + top(d.outEdges));
  if (d.inEdges?.length) out.push('联系他最多：' + top(d.inEdges));
  return out.join('\n');
}

function setReply(gid, member, alias) {
  alias = String(alias || '').replace(/[。！!？?～~]+$/g, '').trim();
  if (!alias) return '要改成什么称呼？';
  if (!rel.setAliasManual(gid, member.uid, alias)) {
    return '改称呼失败：称呼可能含不支持字符，或 ' + (member.name || member.uid) + ' 还没在群里出现过';
  }
  return '已把 ' + (member.name || member.uid) + '(' + member.uid + ') 的称呼设为「' + alias + '」';
}

function forgetReply(gid, uid, alias) {
  alias = String(alias || '').replace(/[。！!？?～~]+$/g, '').trim();
  if (rel.forgetAlias(gid, uid, alias)) {
    return '已删除 ' + (rel.addressFor(gid, uid) || uid) + ' 的别名「' + alias + '」';
  }
  return '没找到别名「' + alias + '」';
}

export function tryHandle({ gid, uid, text, segs, isGroup, mentioned, selfId, enabled = true }) {
  if (!enabled) return null;
  if (isGroup && !mentioned) return null;
  const t = norm(text).replace(/^@\S+\s*/, '');
  if (!t || t.length > 80) return null;

  if (/^(关系网|关系|看看关系|谁跟谁|谁和谁|群里关系|关系怎么样)[?？]?$/.test(t)) {
    return rel.summary(gid);
  }

  let m = t.match(/^(?:查一下|看看|查查|谁是|是谁)\s*(.+?)[?？]?$/);
  if (m) {
    const r = byName(gid, m[1]);
    return r.error || fmtWho(gid, r.member.uid);
  }
  m = t.match(/^(.+?)(?:是谁|什么关系|跟谁最熟)[?？]?$/);
  if (m) {
    const r = byName(gid, m[1]);
    return r.error || fmtWho(gid, r.member.uid);
  }

  m = t.match(/^我是\s*(.+)$/);
  if (m) {
    return setReply(gid, { uid: String(uid), name: rel.addressFor(gid, uid) || uid }, m[1]);
  }

  m = t.match(/^(?:以后|今后|就)?叫(他|她|你|我)?\s*(.+)$/);
  if (m) {
    const r = targetOf({ gid, uid, segs, selfId, pronoun: m[1] });
    return r.error || setReply(gid, r.member, m[2]);
  }

  m = t.match(/^(?:把)?(.+?)(?:以后)?就叫(.+)$/) || t.match(/^(?:把)?(.+?)叫成(.+)$/);
  if (m) {
    const r = byName(gid, m[1]);
    return r.error || setReply(gid, r.member, m[2]);
  }

  m = t.match(/^把?(.+?)的(.+?)(?:删掉|去掉|删了|忘了)[?？]?$/);
  if (m) {
    const r = byName(gid, m[1]);
    return r.error || forgetReply(gid, r.member.uid, m[2]);
  }

  m = t.match(/^(?:别叫|不要叫)(.+?)(?:了|吧)?[?？]?$/);
  if (m) {
    const list = rel.find(gid, m[1]);
    if (!list.length) return '没找到别名「' + m[1] + '」';
    if (list.length > 1) return '「' + m[1] + '」有多个匹配，请用 @ 指定人';
    return forgetReply(gid, list[0].uid, m[1]);
  }

  return null;
}
