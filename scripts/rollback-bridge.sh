#!/usr/bin/env bash
# Roll stable bridge code back to a saved snapshot. Config/data are untouched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STABLE="$ROOT/bridge"
BK="${1:-$(ls -dt "$ROOT"/releases/stable-* 2>/dev/null | head -1 || true)}"
FILES=(qq-bridge.mjs search.mjs relations.mjs relations-nl.mjs)

[ -n "$BK" ] && [ -d "$BK" ] || { echo "[rollback] no snapshot"; exit 1; }
for f in "${FILES[@]}"; do
  [ -f "$BK/$f" ] || { echo "[rollback] missing $BK/$f"; exit 1; }
done

for f in "${FILES[@]}"; do cp -a "$BK/$f" "$STABLE/$f"; done
node --check "$STABLE/qq-bridge.mjs"
systemctl --user restart qq-bridge.service

# 同 promote：用 PID 做锚点（这台机器时钟会跳，不能用 --since）
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
[ "$connected" = 1 ] || { echo "[rollback] PID $PID 未在 15 秒内连上 OneBot"; exit 1; }
node "$ROOT/scripts/check-runtime-units.mjs" --runtime
echo "[rollback] ok; restored=$BK"