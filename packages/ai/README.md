# @app/ai：AI 调用层与多智能体

只用 `fetch`、`ReadableStream`、`DecompressionStream` 等 Web 标准接口，不依赖 DOM 和 Node：浏览器（PWA、安卓 WebView）、Cloudflare Worker、Node 都能直接用。tsconfig 用 `WebWorker` 库，写了 `document` / `window` 会通不过类型检查。

```
src/core/       端点（连接 + 模型）、Base URL 规范化、请求、统一错误 AiError
src/llm/        文本对话：OpenAI 兼容 / DeepSeek / Claude / Gemini（AI Studio）/ Vertex Agent；消息整理、推理强度、回复修剪
src/tts/        语音合成：OpenAI 兼容（硅基流动 CosyVoice）/ MiniMax / 火山引擎（含声音复刻）/ Fish Audio / GPT-SoVITS
src/image/      生图：NovelAI（V4.5 / V4 / V3）/ OpenAI 兼容 /images/generations；生图风格
src/embedding/  向量化：OpenAI 兼容 / Gemini / Workers AI；float16 编码、向量空间
src/agents/     多智能体：路由与备用连接、每日上限、各智能体的提示词与解析、配图流水线、记忆检索
src/connection.ts  拉取模型列表、测试连接
```

测试：`pnpm --filter @app/ai test`（`test/` 里三个文件：文本对话、语音和生图、多智能体；用假的 fetch，覆盖分块边界、各家返回格式、各种报错重试）。

参考了三个项目：math-reader（文本对话的调用）、SleepTogether（SillyTavern 扩展：主备 API、输出修剪、TTS、生图）、SillyTavern 本体（各家参数、消息整理、推理强度、TTS 文字处理）。

## 文本对话（移植自 math-reader）

对应 math-reader `docs/index.html` 的 `callAI` / `doAIRequestPreferStream` / `readAIStream` / `doClaudeRequest` / `doGeminiRequest`：

- **读流**（`llm/stream.ts`）：按正文第一个字符判断 SSE / JSON 数组 / 逐行 JSON / 单个 JSON（服务端忽略了流式参数），不看 content-type。正文、思考内容（`reasoning_content`、`reasoning`、Claude `thinking_delta`、Gemini `thought`）、正文开头的 `<think>…</think>` 分开给。状态：`sent → connected → thinking → streaming`，以及 `fallback` / `unstreamed` / `buffered`。
- **流式失败改普通请求**（`llm/client.ts`）：收到正文前失败，同一个连接改普通请求再试；Key 不对、没余额、404 这类不重试。
- **按报错调整参数**（`llm/retry.ts`）：输出 token 超上限时读出上限重试并记住；400 / 422 提到某个可选参数（`thinking`、`temperature`、`top_k`、`response_format`……）就去掉再发；OpenAI 推理模型要 `max_completion_tokens` 时自动换。
- **Claude**：`claudeModelInfo` 判断不接受 temperature、默认会思考的型号。修了一处：原来的正则会把 `claude-3-5-sonnet-20241022` 的日期当成大版本号。
- **比 math-reader 多的**：可以取消（AbortSignal）；记录用量和结束原因；空回复算失败（可以换备用连接）；消息格式统一转换（开头的系统消息合成 system、中途的系统消息改 user、同角色合并、示例对话的 `example_user` / `example_assistant` 换成真名，同 SillyTavern）。

## 文本对话（参考 SillyTavern、SleepTogether）

- **消息整理**（`llm/messages.ts` 的 `postProcessMessages`，ST 的 Prompt Post-Processing）：连接上选 原样 / 合并 / 半严格 / 严格 / 单条；严格模式下系统消息后第一条不是 user 时补 "Let's get started."。导入的 ST 预设里的 `custom_prompt_post_processing` 也认。
- **推理强度**（`llm/reasoning.ts`）：自动 / 关闭 / 最低 / 低 / 中 / 高 / 最高，按各家换算：OpenAI `reasoning_effort`；Claude 新模型用 adaptive thinking + `output_config.effort`，老模型按回复上限算 `budget_tokens`；Gemini 2.5 用 `thinkingBudget`（2.5 Flash 能关到 0）、Gemini 3 用 `thinkingLevel`、Gemini 4 只认 `thinkingLevel` 且没有 MINIMAL（Vertex 官方文档）；DeepSeek 用思考开关。中转常用的 `-thinking` / `-high` 这类模型名后缀也能识别（同 SleepTogether），自动把温度设成 1、留够输出上限。
- **Claude 型号表**（`llm/claude.ts`）：哪些型号会思考、哪些不接受 temperature / top_p、哪些不能预填 assistant（预填改成 user 消息合并），同 ST 的规则；预设里的 `assistant_prefill` 会接上。
- **Gemini**：安全过滤全部 `OFF`（含 CIVIC_INTEGRITY，同 ST）；要思考过程时带 `includeThoughts`。
- **额外请求参数**：连接上可以并入、去掉请求体的字段（ST 的 Include / Exclude Body Parameters），给只认某些字段的中转用。
- **备用连接发最简请求**（同 SleepTogether 的备用 API）：只带 model / messages / temperature / max_tokens / stream，不带思考参数和额外字段，换过去更容易成功。
- **回复修剪**（`llm/filter.ts`，SleepTogether 的全局正则）：所有文本智能体的回复过一遍正则，默认去掉 `<think>…</think>`、只剩结束标签的半截思考、`<!-- consider: … -->`；流式时每次更新都修剪。修剪完是空的算失败。
- **流式兼容**：有的中转在流里给 `message.content` 或 `text` 而不是 `delta.content`，都认。

## 本机服务（Termux 等）

- `127.0.0.1` / `localhost` 和局域网地址（`core/endpoint.ts` 的 `addressSpace`）不填 Key 也能用：路由不会因为没 Key 改用演示模型，请求不带鉴权头。
- 粘的完整地址照原样用（同 math-reader 的 `fetch(config.url)`）：`http://127.0.0.1:8787/chat/completions` 不会被补成 `/v1/chat/completions`；只填域名时才补 `/v1`。
- 连不上时（浏览器只给 "Failed to fetch"），按地址说明要查什么：本机服务在不在跑、跨域、Chrome 的"本地网络访问"；https 网页连局域网 http 地址时带 `targetAddressSpace: 'local'`。
- OpenAI 官方（api.openai.com）一开始就用 `max_completion_tokens`。

## DeepSeek（按官网文档，2026-11）

- 地址 `https://api.deepseek.com/chat/completions`，模型 `deepseek-flash`（V4.1 Flash，能看图）/ `deepseek-v4-pro`。
- 思考模式默认开、强度 high：推理强度换成 `thinking: {type}` 和 `reasoning_effort`（low / high / max），"关闭"发 `thinking: {type: "disabled"}`。思考模式下回复上限也算思考的 token，自动留出空间（至少 16K，最高强度 64K），免得只有思考、没有正文。
- 预设的助手预填走前缀续写（Beta）：地址换成 `/beta/chat/completions`，最后一条 assistant 带 `prefix: true`。
- 旧模型名 `deepseek-chat` / `deepseek-reasoner` 已在 2026-07-24 停用：调用时换成 `deepseek-flash` 的非思考 / 思考模式；以前存的设置打开 App 时也改过来。
- 选成"OpenAI 兼容"、地址是 `api.deepseek.com` 的连接也按这些规则发（math-reader 里 deepseek 渠道就是填这个地址）。

## Vertex Agent（按 math-reader main 和 Google 官网）

Google 的 Gemini Enterprise Agent Platform（原 Vertex AI），math-reader 里叫 Vertex Agent。

- **API Key**（同 math-reader）：默认地址 `https://aiplatform.googleapis.com/v1/publishers/google`，请求 `{base}/models/{model}:streamGenerateContent?alt=sse&key=…`，Gemini 原生协议；基础地址和完整的 generateContent 地址都能粘。这种 Key（express 模式，或绑定服务账号的 Google Cloud API Key）只能调 Gemini，也拉不到模型列表（要 OAuth），"拉取模型列表"列出常用模型。
- **服务账号 JSON**（官方文档的 Google Cloud 授权）：Key 里粘整个 JSON，本机用 WebCrypto 签 JWT（RS256）、到 `oauth2.googleapis.com/token` 换访问令牌（缓存到过期前一分钟）；请求发到 `…/v1/projects/{项目}/locations/{地区}/…`，地区默认 `global`，连接上可以改地区、填项目 ID。
- **DeepSeek 等开源模型**：要用服务账号授权（官方：OpenAI 兼容接口只认 Google Cloud 授权）。走 `…/endpoints/openapi/chat/completions`，模型名带发布方前缀（`deepseek-ai/deepseek-v4.1-flash-maas`，只写 `deepseek-v4.1-flash-maas` 会自动补上）；官方要求第一条是 user、user 和 assistant 轮流，默认按"严格"整理消息。
- 安全设置按 Vertex 文档的四类关掉；`thinkingLevel` 写成大写枚举。

**math-reader 的"自定义"渠道**走的是 Gemini 原生协议（任意地址，Key 放在 key 参数）；这里对应"自定义 Gemini 协议"模板。任意地址的 OpenAI 格式用"自定义 OpenAI 兼容"模板，粘 math-reader 习惯的完整地址（…/v1/chat/completions）也行。

## 语音合成、生图（参考 SleepTogether、SillyTavern）

- **TTS**（`tts/`）：朗读前去掉控制标签、代码块、`<标签>…</标签>`（状态栏）、动作描写、表情符号、消息开头的"名字："；可以只读引号里的话、星号和括号里的字读不读、另加正则（ST 的 TTS 设置）。表情映射成情绪（角色的 `emotionMap` 优先）：CosyVoice 用"请用害羞的语气说<|endofprompt|>正文"，gpt-4o-mini-tts 用 `instructions`，MiniMax 用 `emotion`，Fish Audio S1 在正文前加 `(embarrassed)`。硅基流动的系统音色只写名字也行（自动补成"模型:音色"）。同一句话按缓存的键复用音频。
- **火山引擎**（`tts/volcengine.ts`，移植自 SleepTogether）：v3 单向流式接口，逐行 JSON 拼音频；`X-Api-App-Key` 被拒（401 / 403）时换 `X-Api-App-Id` 再试一次；复刻的音色（`S_` 开头）自动用 `seed-icl-2.0`。声音复刻：上传录音 → 查训练进度。
- **NovelAI**（`image/novelai.ts`）：V4 起用 `v4_prompt`，两个人同框时用 `char_captions` + `characterPrompts` 指定左右位置；质量词和负面预设默认不加（同 SleepTogether，前缀里自己写），打开"追加官网的质量词"才加；采样器、噪声调度（V4 默认 karras）、Variety Boost（同 ST，按画面大小算 `skip_cfg_above_sigma`）；返回的 zip / JSON / 直接的图片都认，zip 用 `DecompressionStream('deflate-raw')` 解；公益站、反代填它的地址即可，查订阅时 404 不算失败。不给种子就随机一个，再从返回 PNG 的元数据核对；429（同一时间只能生成一张）等两三秒重试。
- **生图风格**（`image/style.ts`）：固定前缀 / 后缀 / 负面词（默认值取自 SleepTogether 和 ST），前缀里写 `{prompt}` 可以指定提示词的位置（同 ST）。
- **OpenAI 兼容生图**：硅基流动（Kolors、FLUX）和 OpenAI 的字段不同，按地址区分；尺寸按模型取最接近的比例（DALL·E 3、gpt-image）；负面词对 OpenAI 写成 "Avoid: …"；返回的 base64、链接、data URL、Markdown 图片都能取出来（`image/extract.ts`）。
- **生图提示词**：画面 / 背景 / 自拍三种模式（背景模式不画人）。

## 向量化（没有参考，按各家接口写）

- 记忆用 `document`、检索的查询用 `query`：e5 加 `query:` / `passage:`，Qwen3-Embedding 的查询加指令，Gemini 带 `taskType`；分配的 `extra.queryPrefix` / `documentPrefix` 可以覆盖。
- 分批（OpenAI 兼容 32、Gemini 100）、单位化、检查条数和维度；`extra.dimensions` 作为输出维度。Workers AI 直连时走 Cloudflare 的 OpenAI 兼容接口（同 ST）。
- 检索可以设最低相似度（ST 默认 0.25），太不相关的记忆不带。
- **向量空间** = 模型族 + 维度（`BAAI/bge-m3` 和 `@cf/baai/bge-m3` 是同一族）。只会换到同一族的备用连接，不同模型的向量不能比较；换模型后 `staleMemories` 找出要重算的记忆。
- 向量存成 float16 小端序 base64（1024 维约 2 KB），`rankMemories` 按设计文档 §6.1 打分：`0.6·相似度 + 0.2·e^(−天数/30) + 0.2·重要度/10`，置顶和到期的待跟进必带。

## 多智能体（`agents/`）

- **路由**：每个智能体按"连接 + 模型 + 备用连接"调用。`status(role)` 说明为什么不能用（没分配、连接删了、没填 Key、协议不支持、要经 Worker 但没连上），App 据此决定真调用还是用演示模型。主连接失败且值得换时改用备用并回调 `onFailover`；取消和超预算不换。
- **AgentSystem**：`chat` / `json`（解析失败把原输出和提醒发回去再要一次）/ `speak` / `draw` / `embed`。分配里的参数只补请求没写的；每日 token 上限；语音只换同一种协议的备用连接（音色 id 只在同一家有效）。
- **智能体**：番外（`sidestory.ts`，你不在时她那边发生的事，可以引出主动消息 `hook` 和配图 `cg`）、生图提示词（`imagePrompt.ts`，外观 tags 由程序放最前面）、总结 / 记忆（`summary.ts`，设计文档 §4.2 的 JSON，好感变化截到 ±3）。
- **配图流水线**（`illustrate.ts`）：画面描述 → 生图提示词智能体 → 生图智能体，分阶段报告；没分配生图提示词智能体时用外观 tags + 原文。
