#!/usr/bin/env bash
# Promote bridge-test code to stable. Stable config/data are NEVER overwritten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STABLE="$ROOT/bridge"
TEST="$ROOT/bridge-test"
BKROOT="$ROOT/releases"
FILES=(qq-bridge.mjs search.mjs relations.mjs relations-nl.mjs)

for f in "${FILES[@]}"; do
  [ -f "$TEST/$f" ] || { echo "[promote] missing $TEST/$f"; exit 1; }
done

node --check "$TEST/qq-bridge.mjs"
node "$ROOT/scripts/check-bridge-test-features.mjs"
node "$ROOT/scripts/check-runtime-units.mjs"

TS="$(date +%Y%m%d-%H%M%S)"
BK="$BKROOT/stable-$TS"
mkdir -p "$BK"
for f in "${FILES[@]}"; do cp -a "$STABLE/$f" "$BK/$f"; done

restore() {
  echo "[promote] restoring $BK"
  for f in "${FILES[@]}"; do cp -a "$BK/$f" "$STABLE/$f"; done
  systemctl --user restart qq-bridge.service || true
}
trap 'echo "[promote] failed"; restore; exit 1' ERR

for f in "${FILES[@]}"; do cp -a "$TEST/$f" "$STABLE/$f"; done
node --check "$STABLE/qq-bridge.mjs"
systemctl --user restart qq-bridge.service

# 用「本次启动的 PID」做锚点，而不是时间戳 —— 这台机器时钟会在 02:4x / 08:2x 之间跳，
# journalctl --since 会漏掉或误匹配（2026-10-20 实测，导致晋级反复误判失败）。
PID="$(systemctl --user show -p MainPID --value qq-bridge.service 2>/dev/null || echo 0)"
connected=0
for _ in $(seq 1 15); do
  sleep 1
  systemctl --user is-active --quiet qq-bridge.service || continue
  if journalctl --user -u qq-bridge --no-pager 2>/dev/null | grep -F "node[$PID]" | grep -q "OneBot 已连接"; then
    connected=1
    break
  fi
done
[ "$connected" = 1 ] || { echo "[promote] PID $PID 未在 15 秒内连上 OneBot"; false; }
node "$ROOT/scripts/check-runtime-units.mjs" --runtime

trap - ERR
echo "[promote] ok; backup=$BK"