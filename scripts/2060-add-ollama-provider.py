#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
在 2060 本上为 OpenClaw 增量添加 Ollama 本地 provider。
- 自动备份 openclaw.json
- 只新增 models.providers.ollama，不改动 auth / gateway / skills / agents
- 幂等：重复运行只更新 ollama 段

用法：
    python3 2060-add-ollama-provider.py            # 只添加 provider
    python3 2060-add-ollama-provider.py --set-default   # 顺便把默认模型切到 qwen3.5:4b
然后：
    openclaw config validate && openclaw gateway restart
"""
import json, os, shutil, sys, time, pathlib

CFG = pathlib.Path.home() / ".openclaw" / "openclaw.json"
OLLAMA_BASE = "http://127.0.0.1:11434/v1"

MODELS = {
    # 实测 2026-10-18：57 tok/s，32k 全显存零掉速，支持 tools/vision/thinking
    "qwen3.5:4b": {
        "name": "本地 Qwen3.5-4B（主力）",
        "contextWindow": 32768,
        "maxTokens": 2048,
        "reasoning": False,
        "inputTypes": ["text", "image"],
        "cost": {"input": 0, "output": 0},
    },
    # 备选：实测 30 tok/s，但不受 think:false 控制、基线 3 例全败，不推荐
    "ds7b:latest": {
        "name": "本地 DS-7B（备选）",
        "contextWindow": 32768,
        "maxTokens": 2048,
        "reasoning": True,
        "inputTypes": ["text"],
        "cost": {"input": 0, "output": 0},
    },
    "deepseek-r1:7b": {
        "name": "本地 DeepSeek-R1-7B (Q3_K_M)",
        "contextWindow": 16384,  # OpenClaw 基础提示约 10.9k，低于 16k 会截断
        "maxTokens": 2048,
        "reasoning": True,
        "inputTypes": ["text"],
        "cost": {"input": 0, "output": 0},
    },
}

def main():
    set_default = "--set-default" in sys.argv
    if not CFG.exists():
        sys.exit(f"[x] 找不到 {CFG}，请先安装/初始化 OpenClaw")

    raw = CFG.read_text(encoding="utf-8")
    try:
        cfg = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"[x] openclaw.json 不是标准 JSON（可能是 JSON5 带注释）：{e}\n"
                 "    请先手工去掉注释，或改用 `openclaw models add ollama` 向导。")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = CFG.with_name(f"openclaw.json.bak.{stamp}")
    shutil.copy2(CFG, bak)

    models = cfg.setdefault("models", {})
    models["mode"] = "merge"          # 关键：与内置/云端 provider 并存
    prov = models.setdefault("providers", {})

    existed = "ollama" in prov
    prov["ollama"] = {
        "baseUrl": OLLAMA_BASE,
        "apiKey": "ollama",           # 本地无需真实 key
        "api": "openai-completions",  # 必填，漏了会报 api: undefined
        "timeoutSeconds": 300,
        "requiresStringContent": True,
        "models": MODELS,
    }

    if set_default:
        cfg.setdefault("agents", {}).setdefault("defaults", {})["model"] = "ollama/qwen3.5:4b"

    CFG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(CFG, 0o600)

    print(f"[✓] 备份: {bak.name}")
    print(f"[✓] ollama provider {'已更新' if existed else '已新增'}: {OLLAMA_BASE}")
    print(f"    模型: {', '.join(MODELS)}")
    if set_default:
        print("[✓] 默认模型已切到 ollama/qwen3.5:4b")
    else:
        print("    提示: 切换模型用 `openclaw models set ollama/qwen3.5:4b`")
    print("    下一步: openclaw config validate && openclaw gateway restart")

if __name__ == "__main__":
    main()
