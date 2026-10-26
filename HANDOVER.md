# 交接：双机混合 Agent 工程

> 这份文档是给 **2060 算力端上的 OpenClaw `main` agent** 看的。
> 你接手时先读本文，再按需读 `projects/agent-dual-machine/README.md` 与 `docs/`。

---

## 1. 你在这套系统里的位置

| 角色 | 位置 | 说明 |
| --- | --- | --- |
| **控制端** | Windows 192.168.1.10 | 人操作的机器，写配置、调试、验收 |
| **算力端（你所在）** | Ubuntu 192.168.1.20，用户 `user` | 跑模型、跑服务、执行任务 |
| 你的身份 | OpenClaw agent `main` | 模型 `deepseek/deepseek-v4-pro`（云端） |
| 平行的执行体 | DSH（本地 `qwen3.5:4b`）+ QQ 桥 | 不归你管，但会共用 Ollama |

---

## 2. 项目文件在哪

```
~/.openclaw/workspace/projects/agent-dual-machine/
├── README.md          ← 总目录，先看这个
├── docs/01~11         ← 摸底、调参、DSH 配置、QQ 方案
├── bridge/qq-bridge.mjs
├── config/            ← OpenClaw / DSH / Ollama 配置模板
├── scripts/           ← 摸底、部署、推送脚本
├── testcases/         ← 3 类标准用例
└── prompts/
```

---

## 3. 当前在跑的服务

| 端口 | 服务 | 备注 |
| --- | --- | --- |
| `11434` | Ollama 0.40.6 | 仅监听 127.0.0.1；`KEEP_ALIVE=-1`、`KV_CACHE_TYPE=q8_0`、`CONTEXT_LENGTH=32768` |
| `18789` | OpenClaw 网关 | 你自己 |
| `3080` | DSH web | `chat` 或 `task` profile，**同时只能跑一个** |
| `5099` | SnowLuma WebUI | **尚未安装** |

**可用模型**

| 模型 | 速度 | 用途 |
| --- | --- | --- |
| `qwen3.5:4b-chat` | 55 tok/s | 快速聊天（参数已固化：temp0.4 / 72 tok / ctx16k） |
| `qwen3.5:4b` | 55 tok/s | 通用 / 任务执行 |
| `qwen3.5:4b-deep` | 55 tok/s | 深度思考档（实用价值低，见 docs/07） |
| `q4-task`（14B IQ2_M） | 7 tok/s | 离线兜底，Base 版不稳定 |
| `deepseek-r1:7b` 等 | 20~30 tok/s | **不要用于执行类任务**，命令全错 |

---

## 4. 硬约束（违反会出问题）

1. **Qwen3 系模型必须显式 `think:false`**，否则 token 全进思考区、正文为空。
2. **不要用 scp 覆盖 `~/.openclaw/openclaw.json`** —— 里面有你自己的 auth（DeepSeek 鉴权），覆盖会丢登录态。要改就增量合并并备份。
3. **不要手改 `~/.dsh/storages/workspace.json`** —— 它有「表 + `workspaceIds`」两个真源，必须同步，否则工作区服务整体起不来。
4. **不要 `pkill -f dsh`** —— 会连带杀掉执行命令的 SSH 会话（命令行里含同样字符串）。按端口找 PID：`ss -lntp | grep :3080`。
5. **你的基础提示约 10.9k token**，在这块 6GB 显卡上仅 prefill 就要 6~7 秒。**凡是对延迟敏感的场景（聊天/QQ），不要走你这条链路**，用 `qq-bridge.mjs` 直连 Ollama。
6. **QQ 机器人只用测试小号**，群聊只在被 @ 时回复。协议实现有封号风险。
7. **不要给 QQ 链路接「agent 式搜索」**（你的 skill 或 DeepSeek `web_search`）。实测：你这条路 prefill 6~7s；DS 的 `v4-pro` 搜索 15.7s / 6.1k 输入 token，`v4-flash` 根本不触发。搜索走 `bridge/search.mjs` 的确定性检索。
8. **搜索的检索词必须清洗**（去掉「帮我查一下」）。实测带指令词返回百度经验/知乎，去掉后是官方文档。改完用 `tail ~/qq-bridge.log` 看 `q="..."` 确认实际检索词。
9. **通用搜索抓不到结构化数据**（天气/股价/比分），别在这上面调 prompt —— 要给这类需求接专用 API。
10. **桥是单实例的**（`.bridge.pid` 锁）。**不要用 `pgrep -f qq-bridge` 批量 kill** —— 这条命令会把执行它的 SSH 会话一起匹配到并杀掉（`bash -c` 的命令行里含同样字符串）。要杀就按 `/proc/*/cmdline` 过滤出真正的 node 进程，或用 `bash scripts/run-bridge.sh`（它会先清残留再启动）。
11. **桥由 systemd user 服务托管**：`systemctl --user restart qq-bridge`（日志用 `journalctl --user -u qq-bridge -f`）。**不要再 `nohup` 手动起** —— 那会和服务各起一个，造成同一条消息回两遍。已在 `.config/systemd/user/qq-bridge.service` 且 `enable-linger`。
12. **会话存档 `bridge/.state.json` 含聊天原文**（权限 600，TTL 30 分钟）。不要把它拷进项目目录做备份，也不要提交。
13. **数字/计数类任务必须走对账层**（`scripts/task-verify.mjs`），不要直接问模型。实测同一任务两次给出 0 和 1，而答错那次更快 —— 它会相信"写错的正则"跑出的 `0`。对账层会用代码按字面量独立复核，不一致就打回重跑。
14. **改文件前先 check，改完在 `CHANGELOG.md` 留痕**（这个工程有多个 agent 在写）：
    - `node scripts/file-guard.mjs check <文件>` → `CLEAN` 才能直接改；`DRIFT` 说明别人动过，**先读最新内容再合并**，禁止用手里的旧版本整份覆盖。
    - 已存在的文件**只用增量编辑**，不整份重写。整份重写已经造成过一次静默丢功能（桥重写丢了 `OLLAMA_URL`/`SYSTEM`）。
    - 施工前在 `CHANGELOG.md` 的「进行中」认领一行，完工后移到「变更记录」，并 `stamp --by <你的名字>`。
    - 改 systemd unit / drop-in 后必须跑 `node scripts/check-runtime-units.mjs --runtime`；稳定服务不能指向 `bridge-test/`，不能留 active drop-in。

---

## 5. 常用命令

```bash
# 看模型与显存占用
ollama list && ollama ps && nvidia-smi --query-gpu=memory.used,memory.total --format=csv

# 本地模型冒烟测试（应 <1s）
curl -s http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen3.5:4b-chat","prompt":"你好","stream":false,"think":false}'

# QQ 桥自测（不需要 QQ / SnowLuma）
node ~/.openclaw/workspace/projects/agent-dual-machine/bridge/qq-bridge.mjs --selftest

# B 档任务 + 对账（数字类任务只用这个入口）
node ~/.openclaw/workspace/projects/agent-dual-machine/scripts/task-verify.mjs "统计 ~/qq-bridge.log 里 [llm+search] 的行数，只回答数字"

# 改文件前查指纹（CLEAN / DRIFT / UNTRACKED）
cd ~/.openclaw/workspace/projects/agent-dual-machine
node scripts/file-guard.mjs check bridge/search.mjs
node scripts/file-guard.mjs stamp --by openclaw

# DSH（二选一）
npx -y @deepseek-ai/dsh --profile chat    # 聊天档
npx -y @deepseek-ai/dsh --profile task    # 任务档

# DSH 配置校验
npx -y @deepseek-ai/dsh --profile chat --dump-config

# 服务状态
systemctl status ollama --no-pager
ss -lnt | grep -E '11434|18789|3080'
```

---

## 6. 当前待办（按顺序）

1. **装 SnowLuma** —— 要求 Node **22.13+**（23 系需 23.4+）；本机是 **v24.22.0，可能不兼容**，必要时 `nvm install 22`。
2. SnowLuma 里配 **OneBot v11 正向 WS**，端口 `3001`。
3. 起桥：`ONEBOT_WS=ws://127.0.0.1:3001 node .../bridge/qq-bridge.mjs`，看到 `[bridge] OneBot 已连接` 即 L2 通过。
4. 小号私聊验证 L3（3 秒内回复、≤50 字）。
5. （可选）给桥配 systemd user service 常驻。

---

## 7. 不要做的事

- ❌ 不要覆盖 `openclaw.json`、不要删 `~/.openclaw/workspace/memory`、不要删 `~/.dsh`
- ❌ 不要用 7B R1 系列做「生成可执行命令」类任务（实测全错）
- ❌ 不要把 14B Base 版当主力（不遵指令、正确性不稳定）
- ❌ 不要把模型文件放系统盘（仅剩 57G）；外接盘在 `/media/user/Seagate Portable Drive`
- ❌ 不要为了"优化体验"把 `num_ctx` 设成 8k 以下——基础提示就吃 10.9k

---

## 8. 排错优先顺序

遇到问题时按这个顺序看，能省大量时间：

1. `ollama ps` —— 模型是否在显存、是否 100% GPU
2. 日志 —— `~/dsh-*.log`、`journalctl -u ollama -n 50`
3. 端口 —— `ss -lnt`
4. 配置合成结果 —— `npx @deepseek-ai/dsh --profile X --dump-config`
5. 才去看文档和源码
