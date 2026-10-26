# C 档（ctask）—— 会动手的任务执行

> 2026-10-22 从 B 档里独立出来。此前它一直混在 `scripts/` 里叫 "b-task-baseline"，
> 而 B 档本身（`btask/run.mjs`）只做搜索和总结，两者能力完全不同。

## 0. 一句话边界

| 档 | 能不能动手 | 入口 | 典型耗时 |
| --- | --- | --- | --- |
| A 档 | 不能，只聊天 | `qq-bridge.mjs` → Ollama | 0.3s |
| **B 档** | **不能**，只能搜索 + 总结 | `btask/run.mjs` | 8~350s |
| **C 档** | **能**：读文件、写文件、执行命令、多步串行 | `scripts/b-task-baseline.sh`、`scripts/task-verify.mjs` | 实测 **185s/任务** |

判据很简单：**任务需不需要碰这台机器。** 不需要 → B 档（便宜、快）；需要 → C 档（能碰，但慢、会挤显存）。

C 档走的是 DSH `headless` profile：模型 `qwen3.5:4b`（**不是** `4b-chat`）+ 工具调用。

## 1. 两个入口，各管一件事

```bash
cd ~/.openclaw/workspace/projects/agent-dual-machine

# ① 跑用例集（5 条，可选只跑一条）
bash scripts/b-task-baseline.sh              # 全部
bash scripts/b-task-baseline.sh 4            # 只跑第 4 条

# ② 单任务 + 对账（数字类任务必须走这个）
node scripts/task-verify.mjs "统计 ~/qq-bridge.log 里 [llm+search] 的行数，只回答数字"
node scripts/task-verify.mjs "<任务>" --retries 2
node scripts/task-verify.mjs "<任务>" --audit-only /tmp/run.json   # 离线复核已存事件
```

用例**只有一份**，在 `ctask/cases.json`；脚本从那里读，文档也从那里引用。改用例只改这一个文件。

> 脚本文件名里的 `b-task` 是历史名。保留原名是因为 `README.md`、`docs/13`、`docs/14`
> 里都按这个名字引用，改名会断掉所有交叉引用。**归属已明确在 C 档**，见本目录。

## 2. 五条用例覆盖什么

| # | 用例 | 能力 | 对账 |
| --- | --- | --- | --- |
| 1 | 本地读取 | 真的去读文件，而不是凭印象答 | — |
| 2 | 联网查证 | 工具调用 + 联网 + "查不到就说查不到" | — |
| 3 | 文件操作 | 写文件 + 回读校验 | — |
| 4 | 计数对账 | 精确计数（4B 最容易静默答错的地方） | ✅ |
| 5 | 多步规划 | 串行多步 + 读命令输出 | — |

第 4 条是核心用例。实测同一个任务跑两次，模型分别答 `0` 和 `1`，**而答错那次更快** —— 它相信了自己写错的正则跑出来的 0，不报错、不犹豫。提示词只能降低概率，代码才能兜住。

**实测（2026-10-22 23:35）**：用例 4 端到端 **185s**，一次通过 —— 模型读了文件（`read` 工具 1 次）、答 `1`，对账层按字面量 `[llm+search]` 独立计数也是 `1`，判定 `LITERAL_VERIFIED`。185s 里模型推理只占一部分，`npx` 冷启动和模型加载占了不少。

## 3. 对账层怎么判

`scripts/task-verify.mjs` 用四种判据，从强到弱：

| 判据 | 触发条件 | 结论 |
| --- | --- | --- |
| `LITERAL_VERIFIED` / `MISMATCH` | 任务含「统计/行数/几次」+ 方括号等字面量 | 代码按字面量独立数一遍，与答案比对 |
| `GREP_VERIFIED` / `MISMATCH` | 模型调用了 `grep` | 用 fs 独立复算（**不执行任何 shell**） |
| `NO_TOOL` | 答案有数字但一次工具都没调 | 凭印象答的 |
| `CONSISTENT` / `NOT_IN_TOOL_OUTPUT` / `FROM_FAILED_CMD` | 其余含数字的答案 | 数字必须出现在**成功**的工具输出里 |

不一致就打回重跑（把差异告诉模型），最多 `--retries` 次。退出码：通过 0，失败 1，用法错误 2。

安全边界：只对 `grep` 做独立复算（纯 fs 读取）。`bash` 类调用只做"数字是否出现在工具输出里"的一致性检查，**不重跑**，避免执行模型生成的命令。

## 4. 验收命令

```bash
# 用例集能跑通（会占显存，A 档首条会慢 3~5 秒）
bash scripts/b-task-baseline.sh 4

# 对账层判据正确（不需要模型，用构造事件）
node scripts/task-verify.mjs "统计 ~/qq-bridge.log 里出现 [llm+search] 的行数，只回答数字" \
  --audit-only /tmp/fake-run.json

# 用例数据源没坏
node -e 'const c=require("./ctask/cases.json");console.log(c.cases.length+" 条用例")'
```

## 5. 已知坑

| 坑 | 说明 |
| --- | --- |
| **不占 A 档模型，但占算力** | 实测跑前跑后 `ollama ps` 都是同一 blob（`qwen3.5:4b-chat`），没有互斥。看到 ctx=4096 不是被改坏 —— 那是 `bridge/qq-bridge.mjs` 的 `DEFAULTS.numCtx`（桥每次请求都带），`ctl.sh warm` 后的 16384 只是 warm 请求不带 `num_ctx`、吃 Ollama 全局值 |
| **`npx` 每次过网络** | 机器上**没有全局 `dsh`**，只能 `npx -y @deepseek-ai/dsh`。断网或 registry 慢会卡住；已有缓存时可离线，但 npx 仍会探一下 |
| **单任务约 3 分钟** | 实测 185s；5 条全跑约 15 分钟。`timeout` 默认 420s，长任务请用 `scripts/remote-run.sh` 托管，别裸跑在 SSH 里 |
| **`~/qq-bridge.log` 停在 10-18** | 桥早改用 journalctl。该文件只当"读文件"的素材，**不要拿它判断桥是否在运行** |
| **数字类不能用 B 档** | 4B 算术不稳（同题跑出 189.2 / 149.2）。算钱、算税、算折扣要么走代码，要么走本档对账 |

## 6. C 档**没有**双轨

和 B 档同理：没有 systemd 单元、`bridge/` 里搜不到它，纯前台 CLI，不存在"线上服务不能坏"的前提。改坏了直接 `cp -a scripts/*.bak-*` 回滚。

## 7. 待办

1. `eval` 侧仍无断言：C 档只有第 4 条会判定 pass/fail，其余 4 条靠人读输出。要把 `cases.json` 里每条的期望写成可机械判定的形式（如 `expect.mustInclude`）。
2. `b-task-baseline.sh` 还不会自动把 `verify: true` 的用例转给对账层 —— 目前要手动跑第二条命令。
3. 没有接进 QQ（也不建议：单任务实测 185s，群里没人等得住）。
