#!/usr/bin/env node
// 启动前特征检查：防止另一版桥静默丢掉群聊窗口 / 人设 / 自消息过滤。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = path.join(root, 'bridge', 'qq-bridge.mjs');
const configPath = path.join(root, 'bridge', 'config.json');

const required = [
  'groupEngagement',
  'quotaUntil',
  'quotaWindowMs',
  'persona',
  'applyPersona',
  'canEngageGroup',
  'String(data.user_id) === String(data.self_id)',
  // 群关系网 + 称呼（workbuddy 2026-10-19 追加）
  'relations.groupEnabled',
  'relationsNl.tryHandle',
  'relations.observe(',
  'relations.addressFor(',
  'applyAddress(',
];

let bridge;
try {
  bridge = fs.readFileSync(bridgePath, 'utf8');
} catch (e) {
  console.error('[check] 无法读取 ' + bridgePath + ': ' + e.message);
  process.exit(1);
}

const missing = required.filter((s) => !bridge.includes(s));
if (missing.length) {
  console.error('[check] qq-bridge.mjs 缺少关键功能: ' + missing.join(', '));
  process.exit(1);
}

try {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!cfg.groupEngagement) {
    console.error('[check] config.json 缺少 groupEngagement');
    process.exit(1);
  }
  if (!cfg.persona) {
    console.error('[check] config.json 缺少 persona');
    process.exit(1);
  }
} catch (e) {
  console.error('[check] config.json 无效: ' + e.message);
  process.exit(1);
}

console.log('[check] bridge features OK');
