# 14 — 复盘：从 SSH 开始的三次偏航

> 2026-10-18 21:50 · 写这篇是因为你指出了一个真问题，不是客套。

## 0. 结论

**第一步就没闭环，后面每一步都在补地基。**

具体到事实：SSH **密钥免密是通的**，但 **`~/.ssh/config` 至今不存在**，别名 `gpu-node` 从来没生效过。今天所有操作都是用 `user@192.168.1.20` 硬连的。

也就是说，"一开始就要整 SSH 密钥"这件事，只完成了 50%，而且剩下那 50% 被忘在了聊天记录里 —— 文档里甚至没有任何一处写它的状态。

---

## 1. 第一次错在哪

### 时间线

| 步骤 | 我当时的判断 | 实际情况 |
| --- | --- | --- |
| 定 IP | 用 `known_hosts` 里的 `192.168.1.30` | 那是另一台**已关机的 Windows**，不是 2060 |
| 定服务 | 以为 Ubuntu 自带 `openssh-server` | 桌面版**没装**，22 端口直接 RST |
| 定方式 | 计划 `ssh-copy-id` 一条命令搞定 | Windows 的 ssh **不能非交互输入密码**，得绕 paramiko |
| 收尾 | 生成 `config/ssh-config.txt`，写"请手动 copy" | 用户没做，我也没回头验收 |

### 三条根因

1. **用历史文件推断当前现状**：`known_hosts` 是 2025 年的记录，我却当成"当前地址"。正确做法是先扫网段（后来做的 `192.168.1.0/24` 扫描 + PTR + MAC 比对）。
2. **把"交付模板"当成"完成任务"**：生成一个需要用户手动执行的模板，等于把任务挂起，而我没给它挂状态。
3. **没有验收动作**：别名能不能用，一条 `ssh gpu-node echo OK` 就能验。我没验，于是它一直是坏的。

---

## 2. "乱来"的三种模式（都真实发生了）

| 模式 | 实例 | 代价 |
| --- | --- | --- |
| **盲写配置** | DSH 的 provider 先挂在 `dsh-llm`（错）→ 报 `no adapter` → 改 `reasoningEffort`（又错，且模型没声明）→ 报 `No API key` → 最后才去读 `dsh-llm-pi-ai` 的 README 和 schema | 4 轮往返，你反复打开页面试错 |
| **整份重写不做 diff** | 桥 v2 从头重写，静默丢掉 `OLLAMA_URL`/`SYSTEM` 两个环境变量；"重复回答抑制"只打日志不拦截 | 功能悄悄消失，直到你问"继承功能呢"才发现 |
| **双入口并存** | `nohup` 手动起 + systemd 服务各一个实例 | 同一条消息回两遍，服务 `NRestarts=19` 空转 |

**共同点：改 → 试 → 错 → 再改。**
正确顺序应该是：**看 → 确认 → 改一次 → 验收。**

DSH 那 4 轮最典型 —— 我读了源码之后，一次就定位到 `reasoningEffort` 存在**会话快照**里、以及 `getSupportedThinkingLevels()` 只返回 `off`。这些事实一直在那儿，只是我先猜了 4 次才去读。

---

## 3. 现在立的规矩（已经在项目里生效，不是口号）

| 规矩 | 落地物 |
| --- | --- |
| 先取证，再改 | DSH 改配置必须 `--dump-config` 看合成结果；查进程按 `/proc/*/cmdline`，不靠猜 |
| 一次一个变量 + 立即验收 | 改桥配置 → 看 `[reload]` 日志；改 ollama → 看 `ollama ps` 的 `context_length` |
| 改前备份、改后对照 | 所有 `cordis.patch.yml` / `workspace.json` 都有 `.bak.<时间戳>`；README 有 v1→v3 功能对照表 |
| 单入口 | 桥只允许 systemd 启动，手动脚本检测到服务在跑就 `exit 2`；进程内有 `.bridge.pid` 锁 |
| 文档写"未完成" | 见下面第 4 节 —— 这次不假装完成 |

---

## 4. 那一步已闭环（2026-10-18 21:58）

你执行了 copy，验证通过：

```
$ ssh gpu-node "echo ALIAS_OK; hostname; whoami"
ALIAS_OK
ubuntu-laptop
user
```

保留下面的命令作为记录（换机器时照做）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
Copy-Item ".\config\ssh-config.txt" "$env:USERPROFILE\.ssh\config"
ssh gpu-node "echo ALIAS_OK"
```

> 如果以后 `~/.ssh/config` 里已经有别的主机配置，**不要整份覆盖**，把 `ssh-config.txt` 里那个 `Host gpu-node` 块追加进去。

---

## 5. 现在的真实状态（不美化）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| SSH 密钥免密 | ✅ | `KEY_AUTH_OK`；`authorized_keys` 1 行、`600`；`~/.ssh` `700` |
| SSH 别名 `gpu-node` | ✅ | `ALIAS_OK`（21:58 验证） |
| SSH 密码登录 | ⚠️ 仍开启 | `sshd_config` 未显式配置 → 默认 `yes` |
| QQ 桥 | ✅ | systemd `active`、`NRestarts=0`、单实例 |
| B 档任务助手 | ✅ 可用 | 4 用例平均 81s，3/4 完全正确 |
| A 档聊天 | ✅ 可用 | 5 问全 ≤50 字、平均 0.31s |

**关于密码登录**：现在关掉是安全的（密钥已验证），但建议**先等别名打通再关**。关的命令（需要 sudo）：

```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload ssh
```

关之前务必先开一个**不关的 SSH 会话**做保险，否则配错了会把自己锁在外面。

---

## 6. 一条给自己的规矩

**每项交付必须带一条可复现的验收命令。**

- SSH 别名 → `ssh gpu-node echo ALIAS_OK`
- 桥常驻 → `systemctl --user show qq-bridge -p MainPID -p NRestarts`
- 会话保持 → 重启后看 `[state] 恢复 N 个会话`
- B 档 → `bash scripts/b-task-baseline.sh`

这次漏的那一步，如果有这条规矩，就不会漏 —— 因为"让用户手动 copy"根本不是一个可验收的交付。
