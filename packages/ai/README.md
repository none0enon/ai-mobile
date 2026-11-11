# @app/ai：AI 调用层与多智能体

只用 `fetch`、`ReadableStream`、`DecompressionStream` 等 Web 标准接口，不依赖 DOM 和 Node：浏览器（PWA、安卓 WebView）、Cloudflare Worker、Node 都能直接用。tsconfig 用 `WebWorker` 库，写了 `document` / `window` 会通不过类型检查。

```
src/core/       端点（连接 + 模型）、Base URL 规范化、请求、统一错误 AiError
src/llm/        文本对话：OpenAI 兼容 / Claude / Gemini
src/tts/        语音合成：OpenAI 兼容（硅基流动 CosyVoice）/ MiniMax / Fish Audio / GPT-SoVITS
src/image/      生图：NovelAI（V4.5 / V4 / V3）/ OpenAI 兼容 /images/generations
src/embedding/  向量化：OpenAI 兼容 / Gemini / Workers AI；float16 编码、向量空间
src/agents/     多智能体：路由与备用连接、每日上限、各智能体的提示词与解析、配图流水线、记忆检索
src/connection.ts  拉取模型列表、测试连接
```

测试：`pnpm --filter @app/ai test`（假的服务端，覆盖分块边界、各家返回格式、各种报错重试）。

## 文本对话（移植自 math-reader）

对应 math-reader `docs/index.html` 的 `callAI` / `doAIRequestPreferStream` / `readAIStream` / `doClaudeRequest` / `doGeminiRequest`：

- **读流**（`llm/stream.ts`）：按正文第一个字符判断 SSE / JSON 数组 / 逐行 JSON / 单个 JSON（服务端忽略了流式参数），不看 content-type。正文、思考内容（`reasoning_content`、`reasoning`、Claude `thinking_delta`、Gemini `thought`）、正文开头的 `<think>…</think>` 分开给。状态：`sent → connected → thinking → streaming`，以及 `fallback` / `unstreamed` / `buffered`。
- **流式失败改普通请求**（`llm/client.ts`）：收到正文前失败，同一个连接改普通请求再试；Key 不对、没余额、404 这类不重试。
- **按报错调整参数**（`llm/retry.ts`）：输出 token 超上限时读出上限重试并记住；400 / 422 提到某个可选参数（`thinking`、`temperature`、`top_k`、`response_format`……）就去掉再发；OpenAI 推理模型要 `max_completion_tokens` 时自动换。
- **Claude**：`claudeModelInfo` 判断不接受 temperature、默认会思考的型号。修了一处：原来的正则会把 `claude-3-5-sonnet-20241022` 的日期当成大版本号。
- **比 math-reader 多的**：可以取消（AbortSignal）；记录用量和结束原因；空回复算失败（可以换备用连接）；消息格式统一转换（开头的系统消息合成 system、中途的系统消息改 user、同角色合并、示例对话的 `example_user` / `example_assistant` 换成真名，同 SillyTavern）；Gemini 按 ST 的默认关掉安全过滤。

## 语音合成、生图（参考 sleep-together）

sleep-together 的分支里有"多端点配置（chat / meta / prompt / image，各自 baseUrl + Key + 模型）"、NovelAI 生图端点、角色的 `voiceId`、生图分阶段的状态，但还没有 TTS 和生图的调用代码。这里沿用它的配置思路（推广成每个智能体单独分配），调用按各家接口文档写。

- **TTS**（`tts/`）：朗读前去掉控制标签、（动作描写）、表情符号；表情映射成情绪（角色的 `emotionMap` 优先）：CosyVoice 用"请用害羞的语气说<|endofprompt|>正文"，gpt-4o-mini-tts 用 `instructions`，MiniMax 用 `emotion`，Fish Audio S1 在正文前加 `(embarrassed)`。硅基流动的系统音色只写名字也行（自动补成"模型:音色"）。同一句话按缓存的键复用音频。
- **NovelAI**（`image/novelai.ts`）：V4 起用 `v4_prompt`，两个人同框时用 `char_captions` + `characterPrompts` 指定左右位置；质量标签和 UC 预设在客户端加（网页版也是）；不给种子就随机一个，再从返回 PNG 的元数据核对；zip 用 `DecompressionStream('deflate-raw')` 解，不引第三方库；429（同一时间只能生成一张）等两三秒重试。测试连接查订阅（`api.novelai.net/user/subscription`），不出图、不花点数。
- **OpenAI 兼容生图**：硅基流动（Kolors、FLUX）和 OpenAI 的字段不同，按地址区分；只给链接时尽量取回字节。

## 向量化（没有参考，按各家接口写）

- 记忆用 `document`、检索的查询用 `query`：e5 加 `query:` / `passage:`，Qwen3-Embedding 的查询加指令，Gemini 带 `taskType`；分配的 `extra.queryPrefix` / `documentPrefix` 可以覆盖。
- 分批（OpenAI 兼容 32、Gemini 100）、单位化、检查条数和维度；`extra.dimensions` 作为输出维度。
- **向量空间** = 模型族 + 维度（`BAAI/bge-m3` 和 `@cf/baai/bge-m3` 是同一族）。只会换到同一族的备用连接，不同模型的向量不能比较；换模型后 `staleMemories` 找出要重算的记忆。
- 向量存成 float16 小端序 base64（1024 维约 2 KB），`rankMemories` 按设计文档 §6.1 打分：`0.6·相似度 + 0.2·e^(−天数/30) + 0.2·重要度/10`，置顶和到期的待跟进必带。

## 多智能体（`agents/`）

- **路由**：每个智能体按"连接 + 模型 + 备用连接"调用。`status(role)` 说明为什么不能用（没分配、连接删了、没填 Key、协议不支持、要经 Worker 但没连上），App 据此决定真调用还是用演示模型。主连接失败且值得换时改用备用并回调 `onFailover`；取消和超预算不换。
- **AgentSystem**：`chat` / `json`（解析失败把原输出和提醒发回去再要一次）/ `speak` / `draw` / `embed`。分配里的参数只补请求没写的；每日 token 上限；语音只换同一种协议的备用连接（音色 id 只在同一家有效）。
- **智能体**：番外（`sidestory.ts`，你不在时她那边发生的事，可以引出主动消息 `hook` 和配图 `cg`）、生图提示词（`imagePrompt.ts`，外观 tags 由程序放最前面）、总结 / 记忆（`summary.ts`，设计文档 §4.2 的 JSON，好感变化截到 ±3）。
- **配图流水线**（`illustrate.ts`）：画面描述 → 生图提示词智能体 → 生图智能体，分阶段报告；没分配生图提示词智能体时用外观 tags + 原文。
