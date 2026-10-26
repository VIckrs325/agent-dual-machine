#!/usr/bin/env bash
# ============================================================
# 2060 本（算力执行端）环境摸底脚本
# 用法（在 2060 本 Ubuntu 上执行）：bash 2060-check-env.sh
# 目的：一次性输出「待收集信息清单」里硬件/环境类全部关键项
# ============================================================
set -u

echo "==================== 系统 ===================="
grep -E "PRETTY_NAME|VERSION=" /etc/os-release 2>/dev/null

echo "==================== 内存 free -h ===================="
free -h

echo "==================== CPU ===================="
lscpu 2>/dev/null | grep -E "Model name|^CPU\(s\)|Core|Thread|Socket"

echo "==================== GPU / NVIDIA ===================="
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi
else
  echo "!! nvidia-smi 不可用：驱动未装或未加载"
fi

echo "==================== CUDA ===================="
if command -v nvcc >/dev/null 2>&1; then
  nvcc --version
else
  echo "!! nvcc 不可用（可稍后按需安装 CUDA toolkit）"
fi

echo "==================== 磁盘 ===================="
df -h / /home 2>/dev/null

echo "==================== 基础依赖 ===================="
for c in python3 pip3 git curl wget node npm docker ollama; do
  if command -v "$c" >/dev/null 2>&1; then
    printf "%-10s %s\n" "$c:" "$(command -v "$c")"
  else
    printf "%-10s %s\n" "$c:" "未安装"
  fi
done

echo "==================== 网络 ===================="
ip -4 addr show 2>/dev/null | grep inet

echo "==================== 端口占用(22/11434/18789) ===================="
ss -tlnp 2>/dev/null | grep -E ":(22|11434|18789)\b" || echo "无相关监听"

echo "==================== 完成 ===================="
echo "请把以上输出回传给控制端（本机）用于生成精确部署方案。"
