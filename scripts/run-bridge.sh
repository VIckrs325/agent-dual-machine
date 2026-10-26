#!/usr/bin/env bash
# 启动 QQ 桥（密钥优先读 tmpfs 缓存 /run/user/<uid>/qq-bridge.env，避免落盘）
# 单实例：启动前先清理残留进程，避免两个桥同时连 OneBot 造成重复回复
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../bridge" && pwd)"
RUNTIME_ENV="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/qq-bridge.env"
ENVF="${HOME}/.qq-bridge.env"
[ -f "$RUNTIME_ENV" ] && ENVF="$RUNTIME_ENV"

if [ -f "$ENVF" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENVF"
  set +a
fi

if [ -z "${ONEBOT_TOKEN:-}" ]; then
  echo "[warn] 未设置 ONEBOT_TOKEN（SnowLuma 若开了鉴权会连不上）" >&2
fi

# --selftest 不占锁、也不该干扰线上进程
if [ "${1:-}" != "--selftest" ]; then
  # 生产由 systemd 托管，手动再起一个会造成双实例（重复回复）
  if systemctl --user is-active --quiet qq-bridge 2>/dev/null; then
    echo "[err] qq-bridge.service 正在运行（systemd 托管），拒绝手动启动第二个实例。" >&2
    echo "      重启：systemctl --user restart qq-bridge" >&2
    echo "      查看：systemctl --user status qq-bridge" >&2
    echo "      日志：journalctl --user -u qq-bridge -f" >&2
    echo "      仅自测：bash $0 --selftest" >&2
    exit 2
  fi
  for p in $(pgrep -f "node .*${DIR}/qq-bridge.mjs" 2>/dev/null || true); do
    [ "$p" = "$$" ] && continue
    echo "[start] 结束残留实例 pid=$p"
    kill "$p" 2>/dev/null || true
  done
  sleep 1
fi

exec node "${DIR}/qq-bridge.mjs" "$@"
