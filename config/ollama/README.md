# Ollama 双档位派生模型

两个派生模型都 `FROM qwen3.5:4b`，共享 blob，不额外占磁盘（各约 3.3GB 显示大小）。

## A 档：qwen3.5:4b-chat（快速聊天）

```dockerfile
FROM qwen3.5:4b
PARAMETER temperature 0.4
PARAMETER top_p 0.9
PARAMETER num_predict 72
PARAMETER num_ctx 16384
PARAMETER repeat_penalty 1.05
```

```bash
ollama create qwen3.5:4b-chat -f chat.Modelfile
```

实测：闲聊 0.3s / 24 字（配合「50 字以内」指令）。

## B 档：qwen3.5:4b-deep（任务执行，思考可选）

```dockerfile
FROM qwen3.5:4b
PARAMETER temperature 0.2
PARAMETER top_p 0.9
PARAMETER num_predict 4096
PARAMETER num_ctx 32768
```

```bash
ollama create qwen3.5:4b-deep -f deep.Modelfile
```

> ⚠️ 实测开启思考（think=true）时，简单题也可能产生 8,831 字符的思考，把输出预算耗尽并返回空正文
> （done_reason=length）。B 档建议默认关思考，靠「工具 + 校验」保证准确，深推理任务路由云端。

## 注意

- `num_predict` 按 **token** 计，不是字数。72 token ≈ 100+ 汉字。
- 严格 50 字需在应用层截断（超长时截到最后一个句号）。
