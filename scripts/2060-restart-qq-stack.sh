#!/usr/bin/env bash
# 干净重启 QQ 链路：SnowLuma + qq-bridge
# 不重启 Ollama；不动 QQ 客户端（需要你手动退出/重开）
set -euo pipefail

BRIDGE="$HOME/.openclaw/workspace/projects/agent-dual-machine/bridge/qq-bridge.mjs"
log() { printf '\n== %s ==\n' "$*"; }

log "停止 qq-bridge.service"
systemctl --user stop qq-bridge.service 2>/dev/null || true

log "清理手动启动的桥"
for pid in $(pgrep -f "$BRIDGE" || true); do
  [ "$pid" = "$$" ] && continue
  kill "$pid" 2>/dev/null || true
done
sleep 1
for pid in $(pgrep -f "$BRIDGE" || true); do
  [ "$pid" = "$$" ] && continue
  kill -9 "$pid" 2>/dev/null || true
done

log "停止 snowluma.service"
systemctl --user stop snowluma.service 2>/dev/null || true

log "按端口清理 5099 残留"
for pid in $(ss -lntp 2>/dev/null | awk '/:5099/ {print $NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true); do
  kill "$pid" 2>/dev/null || true
done
sleep 1

log "确认端口已释放"
if ss -lnt | grep -q ':5099'; then
  echo "5099 仍被占用，请手动检查：ss -lntp | grep 5099"
  exit 1
fi

log "设置 ptrace（注入需要）"
if [ "$(cat /proc/sys/kernel/yama/ptrace_scope)" != "0" ]; then
  sudo sysctl -w kernel.yama.ptrace_scope=0
fi

log "启动 SnowLuma"
systemctl --user daemon-reload
systemctl --user start snowluma.service

for i in $(seq 1 40); do
  if curl -s -o /dev/null http://127.0.0.1:5099; then break; fi
  sleep 1
done
if ! curl -s -o /dev/null http://127.0.0.1:5099; then
  echo "SnowLuma 未在 5099 起来，查看：journalctl --user -u snowluma -n 80 --no-pager"
  exit 1
fi

log "启动桥"
systemctl --user start qq-bridge.service
sleep 1

log "进程检查"
pgrep -af "$BRIDGE" || true

log "服务状态"
systemctl --user --no-pager status snowluma.service | head -12 || true
systemctl --user --no-pager status qq-bridge.service | head -12 || true

cat <<'EOF'

下一步：
1. 打开 http://127.0.0.1:5099，确认 QQ 进程在线；不在就启动 QQ 并登录。
2. 在 SnowLuma 里确认 OneBot 正向 WS 监听 127.0.0.1:3001。
3. 桥日志：journalctl --user -u qq-bridge -f
4. 群里 @ 一次，预期只回一条，并出现 [engage] 窗口日志。
EOF
