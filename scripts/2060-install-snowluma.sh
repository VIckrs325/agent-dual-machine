#!/usr/bin/env bash
# 安装 SnowLuma 到 ~/apps/snowluma（Linux x64 完整发行包）
# 修复：发行包入口 index.mjs / launcher.sh 在归档根目录，不能再猜“顶层目录”。
set -euo pipefail

VER="v1.14.22"
ASSET="SnowLuma-${VER}-linux-x64.tar.gz"
URL="https://github.com/SnowLuma/SnowLuma/releases/download/${VER}/${ASSET}"
DEST="${HOME}/apps/snowluma"
CACHE="${HOME}/apps/.cache"
ARCHIVE="${CACHE}/${ASSET}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1"; exit 1; }; }
need curl
need tar

# engines: ^22.13.0 || >=23.4.0
if command -v node >/dev/null 2>&1; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); const ok=(a===22&&b>=13)||(a>23)||(a===23&&b>=4); if(!ok){console.error("Node "+process.versions.node+" 不满足 ^22.13.0 || >=23.4.0");process.exit(1)}'
  echo "Node: $(node -v)"
fi

mkdir -p "${CACHE}"

# 完整包约 40MB+；小于 10MB 说明拿到的是 lite，删掉重下
if [ -s "${ARCHIVE}" ] && [ "$(stat -c%s "${ARCHIVE}")" -lt 10000000 ]; then
  echo "缓存是 lite 包或下载不完整，删除重下"
  rm -f "${ARCHIVE}"
fi

if [ ! -s "${ARCHIVE}" ]; then
  echo "下载 ${ASSET} ..."
  curl -fL --retry 3 --connect-timeout 15 -o "${ARCHIVE}" "${URL}"
fi
echo "归档大小: $(du -h "${ARCHIVE}" | cut -f1)"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
tar -xzf "${ARCHIVE}" -C "${TMP}"

# 入口必须在根目录；兼容“多包了一层目录”的归档
SRC="${TMP}"
if [ ! -f "${TMP}/index.mjs" ]; then
  CAND="$(find "${TMP}" -mindepth 2 -maxdepth 2 -name index.mjs -printf '%h\n' | head -n1 || true)"
  if [ -n "${CAND}" ]; then
    SRC="${CAND}"
  else
    echo "归档里找不到 index.mjs，内容如下："
    find "${TMP}" -maxdepth 2 | head -50
    exit 1
  fi
fi

rm -rf "${DEST}"
mkdir -p "${DEST}"
cp -a "${SRC}/." "${DEST}/"

[ -f "${DEST}/launcher.sh" ] && chmod +x "${DEST}/launcher.sh"

echo
echo "已安装到 ${DEST}"
find "${DEST}" -maxdepth 1 -printf '%f\n' | sort
echo
if [ -x "${DEST}/launcher.sh" ]; then
  echo "启动： cd ${DEST} && ./launcher.sh"
else
  echo "没有 launcher.sh；入口是 index.mjs，可用： cd ${DEST} && node index.mjs"
fi
echo "WebUI： http://127.0.0.1:5099 （初始密码在启动日志）"
