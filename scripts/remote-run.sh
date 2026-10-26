#!/usr/bin/env bash
# 长任务托管（远程调试用）：把命令交给 systemd 的 transient unit 跑，SSH 断线不影响。
#
#   bash scripts/remote-run.sh "node btask/run.mjs '深度学习是什么' --profile deep"
#   bash scripts/remote-run.sh --name btask-deep "node btask/run.mjs ... --profile deep"
#   bash scripts/remote-run.sh --list
#   bash scripts/remote-run.sh --status btask-deep-20261022-223000
#   bash scripts/remote-run.sh --logs   btask-deep-20261022-223000 80
#   bash scripts/remote-run.sh --stop   btask-deep-20261022-223000
#
# 为什么要这样做：SSH 断开后，前台命令的命运取决于 sshd 的默认行为（本项目
# ClientAliveInterval=0，既不清死连接也不保证孤儿任务存活），实测时好时坏。
# 交给 systemd 后，任务有自己的 cgroup 和 unit 名，断线照跑、随时可查。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

CMD=""
NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      NAME="${2:-}"
      shift 2
      ;;
    --list)
      out="$(systemctl --user list-units 'wbjob-*' --all --no-legend --no-pager 2>/dev/null)"
      if [ -z "$out" ]; then echo "（没有托管任务）"; else printf '%s\n' "$out" | sed 's/^/  /'; fi
      exit 0
      ;;
    --status)
      systemctl --user status "wbjob-${2:-}" --no-pager 2>/dev/null | head -20
      exit 0
      ;;
    --logs)
      journalctl --user -u "wbjob-${2:-}" -n "${3:-40}" --no-pager 2>/dev/null | cut -c1-200
      exit 0
      ;;
    --stop)
      systemctl --user stop "wbjob-${2:-}" 2>&1
      exit 0
      ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      CMD="${CMD:+$CMD }$1"
      shift
      ;;
  esac
done

if [ -z "$CMD" ]; then
  sed -n '2,14p' "$0"
  exit 2
fi

TS="$(date +%Y%m%d-%H%M%S)"
NAME="${NAME:-task}"
UNIT="wbjob-${NAME}-${TS}"

if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --version >/dev/null 2>&1; then
  if systemd-run --user --unit="$UNIT" --collect \
      --property=WorkingDirectory="$ROOT" \
      bash -c "$CMD" >/dev/null 2>&1; then
    echo "[run] 已托管（systemd transient unit）"
    echo "  unit : $UNIT"
    echo "  状态 : bash scripts/remote-run.sh --status ${UNIT#wbjob-}"
    echo "  日志 : bash scripts/remote-run.sh --logs ${UNIT#wbjob-} 80"
    echo "  停止 : bash scripts/remote-run.sh --stop ${UNIT#wbjob-}"
    exit 0
  fi
  echo "[run] systemd-run 失败，回退到 setsid"
fi

LOG_DIR="${RUN_LOG_DIR:-$ROOT/runlogs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/${NAME}-${TS}.log"
setsid bash -c "$CMD" >"$LOG" 2>&1 </dev/null &
PID=$!
sleep 0.4
if kill -0 "$PID" 2>/dev/null; then
  echo "[run] 已托管（setsid，无 systemd 依赖）"
  echo "  pid  : $PID"
  echo "  日志 : $LOG"
  echo "  跟踪 : tail -f $LOG"
else
  echo "[run] 启动即退出，日志如下："
  cat "$LOG" 2>/dev/null
  exit 1
fi
