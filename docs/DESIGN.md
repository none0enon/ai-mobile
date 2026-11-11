# AI 陪伴 App 设计文档

> 状态：M1 进行中。已完成：SillyTavern 导入（角色卡 / 世界书 / 预设）、按 ST 规则拼提示词、本机存储导入的数据；AI 调用层与多智能体（`packages/ai`，§4.5）：填了 Key 的智能体真的调用（对话、番外、生图提示词、生图、语音合成、向量化），连接和分配存本机、Key 只在本机。还没有：导出按钮、聊天记录导入、导入时生成小世界、记忆和番外的持久化、语音识别。其余仍是 M0 的演示数据。
> 云端主动消息实现更新：已补上 `apps/hub` 的 5 分钟 Cron、D1 排期/消息持久化、并发触发、闸门、独立重试、上下文上传、增量收件箱及 Web Push/webhook；不再由前端计时器生成计划消息。部署和当前范围见 [CLOUDFLARE.md](CLOUDFLARE.md)。完整 M2 同步、R2 和安卓壳仍未完成。
> 约定：文中"她"泛指角色，角色也可以是男性；"你"指使用者。

---

## 0. 一页纸总结

| 决定 | 内容 | 为什么 |
|---|---|---|
| 一套前端三个端 | Vue 3 + Vite + TypeScript。安卓打成 APK（WebView 壳，从 math-reader 演进），iPhone 和电脑用 PWA | 一份代码；APK 补齐推送、闹钟、后台播放、计步 |
| 本地优先 | 界面只读写本机 IndexedDB（Dexie），同步在后台 | 秒开、离线能看、Worker 挂了也能聊 |
| 实时对话直连 | 手机直接请求你自己的 API / 中转（同 math-reader） | 延迟最低；不经过第三方 |
| 自己的云端中枢 | Cloudflare Worker + D1 + R2，负责同步、主动消息、推送、少量代理 | "App 关着也能收到她的消息"必须有常驻的云端 |
| 记录级增量同步 | 服务器分配递增序号 `seq`，按记录拉取 / 推送，删除用墓碑 | 比 math-reader 的快照合并简单；不依赖设备时钟 |
| 多智能体 | 主对话、番外、总结/记忆、向量化、检索、生图提示词、生图、主动消息、视觉、TTS、STT，各自选连接和模型，可设备用连接 | 便宜的活交给便宜的模型；失败自动降级 |
| 向量检索在本机 | 向量（float16）随记忆同步，手机上暴力计算余弦；向量化 API 由你自选 | 不受 Cloudflare 免费额度限制，离线可用 |
| 控制标签 | 回复里夹带 `[expr:smile]` `[cg:…]` `[music:…]` `[call]` `[choice:…]` 等，流式剥离 | 中转对 function calling 支持参差；标签不影响流式正文 |
| 主动消息"先排期再触发" | 每天生成 Touchpoint，Cron 每 5 分钟触发，内容在触发时才写 | 可预测、可幂等、安卓可设精确闹钟 |
| 兼容 SillyTavern | 角色卡 V1/V2/V3、世界书、Chat Completion 预设、聊天 .jsonl 能导入也能导出 | 已有的卡和预设直接用，随时能带走 |
| 消息按人分 + 各自的世界 | 一个角色只有一条聊天。每个角色有自己的虚拟小世界，你在真实世界（Google 地图）；去她的世界找她，或带她出门，都只在这条聊天里记一段"来到… / 离开…" | 像和真人聊天：换个场景不会多出一条会话；她有自己的生活，你出门时也能带上她 |
| 国内网络 | Worker 绑自定义域名；不依赖谷歌服务（不用 FCM、不用 Google Fonts） | `*.workers.dev` 常被屏蔽 |

---

## 1. 产品定位

一个"更像真人"的 AI 陪伴：
- 继承 SillyTavern 的可定制性（角色卡、世界书、预设）；
- 加上真人恋人会做的事：主动来找你、记得你说过的事、知道现在几点下不下雨、陪你吃饭学习睡觉、打电话、一起听歌、约会。

**不做**（至少 M6 之前）：群聊、文本补全（text completion）后端、多用户、上架应用商店。

---

## 2. 需求框架与里程碑

| 层 | 内容 | 里程碑 |
|---|---|---|
| 对话核心 | 角色卡 / 人设 / 世界书 / 预设 / 宏；swipe、重生成、编辑；一个角色一条聊天，IM 和剧场是它的两种看法 | M1 |
| API 与智能体 | 任意个连接 + 每个智能体单独分配 + 自动降级 | M1 |
| 同步 | Worker + D1 增量同步，R2 存素材 | M2 |
| 记忆 | 滚动摘要、记忆条目、向量检索、日记、关系状态、记忆本 | M2 |
| 主动 & 感知 | 时间 / 节气 / 天气 / 今日活动；排期 + 触发 + 推送 + 补发 | M3 |
| 安卓壳 | 通知、精确闹钟、前台媒体服务、计步 / Health Connect、返回键、深链 | M3 |
| 语音 | TTS、STT、语音通话、AI 来电 | M4 |
| 生图 | 生图提示词智能体 + NovelAI + 相册 | M5 |
| 场景 | 七个场景接真实数据 | M6 |

| 里程碑 | 完成标准 |
|---|---|
| **M0（本轮）** | 所有路由可点；手机宽度无横向滚动；构建、类型检查通过；预览链接能打开 |
| M1 核心对话 | 导入一张 ST V3 PNG 角色卡、它的世界书和一个常用预设，导出后字段不丢；在手机上通过你的中转流式聊 50 轮，能停止、重生成、自动降级；"查看提示词"显示的就是真实请求；刷新和离线后数据都在 |
| M2 中枢 + 记忆 | 两台设备离线各改一些（含删除）后能收敛；立绘只上传一次；新开会话她记得上周说过的事；前一晚没打开 App 也有日记 |
| M3 主动 + 安卓 | 关掉 App 一天，iPhone 主屏 PWA 和安卓 APK 各收到 ≥3 条计划内消息，误差 ±5 分钟；点通知直达对应聊天；勿扰和上限生效；补发不重复 |
| M4 语音 | 两种手机上通话 5 分钟，4G 下首句约 2 秒内出声，能打断；通话记录和字幕进聊天；安卓早上被她来电叫醒 |
| M5 生图 | 30 秒内出一张符合角色外观的 CG，用保存的参数能复现 |
| M6 场景 | 七个场景都能从她的世界或你的真实世界进入，提示词里能看到地点和场景规则；结束后聊天里留下"来到… / 离开…"一段和卡片，活动日志也有记录 |

M4–M6 在 M3 之后互不依赖，可以按你的优先级调换（例如先做"一起听歌"，网易云模块很小）。

---

## 3. 总体架构

```
┌───────────────── 客户端（同一份 Vue 代码）─────────────────┐
│ 安卓 APK（WebView 壳 + 原生桥）│ iPhone 主屏 PWA │ 电脑浏览器 PWA │
│ 界面：消息 / 一起 / 回忆 / 我的 + 场景 + 通话 + 设置              │
│ 本地库 Dexie：全部记录 + 向量 + 素材缓存；同步发件箱               │
│ 直连：主对话、视觉、生图提示词、TTS/STT、Embedding（你的 API）     │
└──────┬─────────────────────────────────────┬────────────┘
       │ /v1/sync /v1/blob /v1/relay /v1/push    │ 直连 HTTPS
┌──────▼──────────── Cloudflare Worker（Hono）────────────┐   ┌───────────────┐
│ D1：records（所有可同步记录）、touchpoints、devices、secrets…  │──▶│ 你的 LLM / 中转  │
│ R2：立绘、CG、语音缓存、每日备份（按内容哈希）                    │   │ NovelAI / TTS   │
│ Cron：*/5 触发主动消息；每天 04:00 规划 + 整理记忆 + 写日记 + 备份 │   │ 网易云 / 天气     │
│ 推送：Web Push(VAPID) / webhook（Bark、ntfy、PushPlus、企业微信…）│   └───────────────┘
│ 代理：NovelAI（解 zip）、网易云（cookie 在 secret）、天气缓存、     │
│       不允许浏览器直连的服务（白名单转发）                          │
└──────────────────────────────────────────────────────┘
```

### 3.1 一轮对话
1. 你发消息 → 写本地库 → 进同步发件箱。
2. 组装提示词（见 §5）：预设块 + 角色卡 + 世界书扫描 + 记忆检索（本机向量）+ 【当前环境】+ 场景规则 + 聊天记录。
3. 按"智能体分配"选连接：直连或经 Worker 转发，流式请求。
   - 流式读取移植 math-reader 的 `readAIStream`（`docs/index.html` 20405–20526）：按响应体首字符判断 SSE / JSON，兼容"中转把流标成 JSON"。
4. 每次收到累积全文 → `parseControlTags(全文)` → 显示正文，立绘实时换表情。结束后执行其余标签（配图、歌曲卡、选项、来电）。
5. 回复写本地库并同步。未总结的消息累计到阈值后，在空闲时交给总结智能体。
6. "生成中"的状态只放内存，不进同步数据。生成期间暂停同步。每次 await 之后按 id 重新取对象。这三条都是 math-reader 回滚提交 8f24892 留下的教训。

### 3.2 主动消息
1. 每天 04:00（按你的时区），规划器按规则生成当天的 Touchpoint，`id = 日期:规则`。
2. Cron 每 5 分钟取出到点的 Touchpoint，过闸门：勿扰、上限、你 20 分钟内刚聊过、学习或睡觉中、连续两次没理会就退避。
3. 主动消息智能体用最新上下文写消息 → 写入 D1（`proactive: true`）→ 按推送通道依次尝试。
4. 客户端补齐：
   - 安卓壳到点的精确闹钟拉 `/v1/inbox`；
   - 任何一端打开 App 时都会同步。
   - 因为 id 固定，Worker 触发和打开 App 补发不会重复。

### 3.3 同步与大文件
- 记录：`GET /v1/sync/pull?since=seq`、`POST /v1/sync/push`（§12）。
- 大文件：先 `PUT /v1/blob/{sha256}`，记录里只存哈希。同一个文件只传一次，不需要两段提交。

---

## 4. 智能体与控制标签

### 4.1 分工

| 智能体 | 何时触发 | 产出 | 在哪运行 | 建议模型 |
|---|---|---|---|---|
| 主对话 | 每次发言 | 角色回复（含控制标签） | 本机 | 强模型（Claude / DeepSeek / Gemini，经中转） |
| 番外 | 你很久没来、夜间、手动"写一段她的番外" | 她在自己世界里的一小段故事 + 可能发给你的一句话（hook）+ 适合配图的一幕（cg），JSON | 本机或 Worker | 便宜模型，温度高一点 |
| 总结 / 记忆 | 未总结消息约 30 条、会话结束、夜间 | 章节摘要 + 记忆条目 + 关系变化（JSON） | 本机空闲时 / Worker 夜间 | 便宜快的模型 |
| 向量化 | 新记忆写入、换模型重算 | float16 向量 | 记忆在哪生成就在哪算 | 任意 OpenAI 兼容 `/embeddings`（bge-m3 等） |
| 检索 | 每次发言前 | Top-K 记忆 | 本机 | — |
| 生图提示词 | `[cg:]`、手动"生成配图"、约会关键时刻、主动自拍 | NovelAI tags（JSON） | 本机或 Worker | 便宜模型 |
| 生图 | 上一步之后 | 图片 → R2 → 相册 | Worker（代理 NovelAI） | NovelAI V4.5 |
| 主动消息 | Touchpoint 到点 | 1～2 条消息，可带 `[call]` `[cg]` | Worker | 便宜模型，或和主对话同款 |
| 视觉 | 饭照、运动截图 | 点评 / 结构化数据 | 本机 | 多模态模型 |
| TTS / STT | 语音消息、通话 | 声音 / 文字 | 本机（必要时经 Worker） | CosyVoice / SenseVoice 等 |

每个智能体在"API 与智能体"页单独选：连接 + 模型 + 参数 + 备用连接 + 在哪运行（本机 / Worker / 自动）+ 每日 token 上限。

### 4.2 总结 / 记忆智能体的输出

```json
{
  "summary": "这一段发生了什么（第三人称，100-200 字）",
  "memories": [
    {
      "type": "fact|preference|event|promise|followup|emotion|relationship",
      "content": "他周三下午两点有实习面试",
      "importance": 8,
      "dueAt": "2026-11-11T16:30:00+08:00",
      "supersedes": ["mem_xxx"]
    }
  ],
  "relationship": { "affectionDelta": 1, "mood": "有点想你", "nicknames": { "user": "笨蛋" } }
}
```

- 只从"已定稿"的消息里抽：跳过最后两轮，跳过没被选中的 swipe。
- 好感变化每天最多 ±3。

### 4.3 生图提示词智能体的输出

```json
{ "caption": "雨天的图书馆", "tags": "1girl, …, library, rainy window, warm desk lamp", "negative": "lowres, …", "size": "portrait" }
```

- 外观基础 tags 来自角色卡的"外观 tags"，服装 tags 来自当前场景。

### 4.4 番外智能体的输出

```json
{ "title": "借伞的人", "story": "第三人称的小故事（150–250 字）", "time": "傍晚", "place": "图书馆门口", "mood": "有点好笑", "people": ["学弟"], "hook": "今天把伞借出去了…", "cg": "傍晚图书馆屋檐下，她抱着书看雨" }
```

- 输入：角色卡、她的世界（作息、手头的事、三餐、身边的人）、此刻在哪、她记得的关于你的事、最近的聊天、最近写过的番外标题（避免重复）。
- 你不出场，但她可以想到你、提起你们聊过的事；写一个小而具体的事件，不写流水账。
- `hook` 可以当作一条主动消息发给你；`cg` 交给配图流水线（§4.5）。以后番外写进她的"生活记录"，聊天时她能自然地提起。

### 4.5 AI 调用层（`packages/ai`）

前端和以后的 Worker 共用，只用 Web 标准接口（tsconfig 用 `WebWorker` 库）。说明见 `packages/ai/README.md`。

| 模块 | 内容 | 来源 |
|---|---|---|
| `llm/` | OpenAI 兼容 / Claude / Gemini；读流兼容 SSE、JSON 数组、逐行 JSON、单个 JSON；思考内容和 `<think>`；流式失败同一连接改普通请求；输出上限超了按报错重试；不被接受的参数自动去掉 | 移植自 math-reader 的 `callAI` / `readAIStream` |
| `llm/`（续） | 消息整理（原样 / 合并 / 半严格 / 严格 / 单条）；推理强度按各家换算；Claude 型号表（思考、采样参数、预填）；Gemini 安全过滤 OFF 和思考预算；额外 / 去掉的请求参数；备用连接发最简请求；回复修剪（正则） | SillyTavern 的 Chat Completion 设置；SleepTogether 的主备 API 和全局过滤 |
| `llm/`（DeepSeek、Vertex） | DeepSeek 官方：deepseek-flash / deepseek-v4-pro，思考开关和强度，思考时留足输出上限，前缀续写（/beta），停用的旧模型名自动换；Vertex Agent：API Key 调 Gemini（express 地址），服务账号 JSON 换访问令牌后调项目地址的 Gemini 和 DeepSeek 等开源模型（OpenAI 兼容接口） | DeepSeek 官网文档；math-reader main 的 Vertex Agent 和 Google 官网文档 |
| `tts/` | OpenAI 兼容 `/audio/speech`（硅基流动 CosyVoice）、MiniMax t2a_v2、火山引擎 v3（含声音复刻）、Fish Audio、GPT-SoVITS；朗读前的文字处理（只读引号、星号 / 括号、代码块、状态栏标签、自定义正则）；表情 → 情绪；按句缓存 | SleepTogether 的 TTS 管理（火山引擎、MiniMax）；SillyTavern 的 TTS 设置 |
| `image/` | NovelAI V4.5 / V4（`v4_prompt`、多人位置）/ V3；生图风格（固定前后缀、负面词、采样器、噪声调度、Variety Boost）；质量词默认不加；zip / JSON / 图片都认；种子从 PNG 元数据核对；OpenAI 兼容 `/images/generations`（尺寸、Avoid 负面词） | SleepTogether 的生图管理；SillyTavern 的 NovelAI 设置 |
| `embedding/` | OpenAI 兼容 `/embeddings`、Gemini `batchEmbedContents`、Workers AI（OpenAI 兼容接口）；查询 / 记忆的前缀；float16 base64；向量空间 = 模型族 + 维度；检索最低相似度 | 新写；阈值参考 SillyTavern 的向量存储 |
| `agents/` | 路由（主连接 → 备用，取消和超预算不换）、每日 token 上限、`chat` / `json` / `speak` / `draw` / `embed`、番外 / 生图提示词 / 总结的提示词与解析、配图流水线、记忆检索打分（§6.1） | 新写 |

- **真调用还是演示**：智能体的主连接分配了、这台设备上有 Key（或连接不需要 Key）、协议能做这件事，才真的调用；否则界面继续用演示实现。"API 与智能体"页每个智能体写着"已接通"或"演示模型 · 原因"。
- **Key**：存在本机数据库单独的 `secrets` 表，不和连接、分配放在一起，永远不进同步数据。
- **备用连接**：语音只换同一种协议的备用（音色 id 只在同一家有效）；向量化只换同一个模型族的备用（不同模型的向量不能比较）。
- **设置在哪**："API 与智能体"页：连接（火山引擎填 APP ID；OpenAI 兼容的对话连接在"高级"里选消息整理、写额外 / 去掉的请求参数）、每个对话智能体的推理强度和要不要思考过程、生图智能体的生图风格、回复修剪规则。"语音"页：朗读哪些字、火山引擎的声音复刻。
- **配图**：`[cg:]` → 生图提示词智能体（JSON：caption / tags / negative / size，外观 tags 由程序放最前面）→ 生图智能体 → 本机素材库（`assets` 表，按 SHA-256 内容哈希，以后同一个哈希传 R2）→ 消息里的图片卡片。失败时卡片上写原因，可以重画。

### 4.6 控制标签协议（`packages/shared/src/tags.ts`）

| 标签 | 作用 |
|---|---|
| `[expr:smile]` | 切换立绘表情。只允许立绘套装里有图的表情，列表会写进提示词 |
| `[pose:sit]` `[outfit:pajama]` `[bg:cafe]` | 姿势 / 服装 / 背景 |
| `[cg:画面描述]` | 请求配图 |
| `[music:歌名-歌手]` | 分享歌曲（生成歌曲卡片，可"一起听"） |
| `[call]` | 想打电话（弹出来电横幅） |
| `[choice:A\|B\|C]` | 约会选项（显示成快捷回复） |
| `[poke:部位]` | 回戳你 |

- **兼容写法**：全角 `【expr：smile】`、名字不区分大小写。不认识的方括号（例如"[笑]"）原样保留为正文。
- **两种解析**：
  - `parseControlTags(全文, 场景白名单)`：无状态，每次拿累积全文重新解析，配合 `readAIStream` 的 `onDelta(全文)`。返回每个标签在正文里的位置（剧场模式的打字机打到这里才换表情），结尾半截标签先隐藏（`pending`）。
  - `createTagStripper()`：给只提供增量的流用。
- **场景白名单**：不在当前场景白名单里的已知标签，照样从正文去掉，但不执行。

---

## 5. 提示词组装（兼容 SillyTavern）

### 5.1 默认顺序（预设"陪伴 · 日常"）

| # | 块 | 类型 | 位置 |
|---|---|---|---|
| 1 | 主提示 | 预设文字 | 顺序 |
| 2 | 世界书（角色前） | 程序填充 | 顺序 |
| 3–5 | 角色描述 / 性格 / 场景 | 程序填充 | 顺序 |
| 6 | 世界书（角色后） | 程序填充 | 顺序 |
| 7 | 用户人设 | 程序填充 | 顺序 |
| 8 | 示例对话 | 程序填充 | 顺序 |
| 9 | 过往摘要 | 程序填充 | 顺序 |
| 10 | 聊天记录 | 程序填充 | 顺序（按 token 预算截取） |
| 11 | 长期记忆 + 关系状态 | 程序填充 | 聊天记录倒数第 4 条前 |
| 12 | 【当前环境】 | 程序填充 | 倒数第 2 条前 |
| 13 | 当前场景规则 + 可用标签 | 程序填充 | 倒数第 1 条前 |
| 14 | 控制标签说明 | 预设文字 | 顺序 |
| 15 | 后置指令（破限） | 预设文字 | 顺序 |

- **排序原则**：稳定内容在前、易变内容按深度插进聊天记录末尾。这样能命中 DeepSeek / OpenAI 等的前缀缓存。
- **作者注**：按 ST 的 depth 规则插入。角色卡的 `extensions.depth_prompt` 同样按深度插入。
- **"查看提示词"页**（`/chat/:id/inspect`）：发送时拼好的提示词原样留在内存里，这里列出发出去的每一条消息、预设每一块（发没发、为什么）、世界书每一条（触发没有、为什么）、请求体。还没发过时按现在的聊天预览（不推进世界书的粘性 / 冷却）。
- **实现**：`packages/shared/src/st/assemble.ts`（按 ST 的 `populateChatCompletion`），App 的四块内容在 `apps/web/src/services/prompt.ts` 里填好传进去。和 ST 一致的细节：
  - 预设里关掉的块不发；关掉的主提示在 ST 里是一个空占位，同样不发；空内容的消息不发。
  - 聊天记录开头插 `new_chat_prompt`；示例对话每段前插 `new_example_chat_prompt`，每句是带 `example_user / example_assistant` 名字的系统消息。
  - 按深度插入的内容（预设的 in-chat 块、世界书 @深度、角色卡 `depth_prompt`、作者注位置的世界书）同深度同角色合成一条；`injection_order` 大的更靠后。
  - 角色卡的 `system_prompt` / `post_history_instructions` 覆盖主提示 / 后置指令，可用 `{{original}}`。
  - 预算 = 上下文 − 回复最长；聊天记录从最新往旧放，示例对话最后放。
  - 比 ST 多做的一点：示例对话也认全角冒号"名字："（ST 会把这种行丢掉）。

### 5.2 宏

| 宏 | 含义 | 里程碑 |
|---|---|---|
| `{{char}}` `{{user}}` | 角色名 / 你的人设名 | M1 |
| `{{time}}` `{{date}}` `{{weekday}}` | 当前时间 | M1 |
| `{{random::a::b}}` `{{random:a,b}}` `{{roll:d6}}` | 随机 | M1 |
| `{{idle_duration}}` | 距上次聊天多久 | M1 |
| `{{weather}}` | 天气一句话 | M3 |
| `{{getvar::x}}` `{{setvar::x::v}}` | 会话变量 | M1 |
| 场景变量 `{{song}}` `{{place}}` `{{part}}` `{{combo}}` | 场景规则里用 | M6 |

### 5.3 世界书扫描
- 主 / 次关键词与逻辑（含任一 / 不全含 / 都不含 / 全都含）。
- 常驻条目、概率、扫描深度、插入位置和深度、顺序、分组（同组只选一条）。
- 递归扫描（可禁止 / 排除）、粘性、冷却、延迟。
- Token 预算超出时，按顺序丢弃靠后的条目。
- 中文不做"整词匹配"。
- 实现：`packages/shared/src/st/worldinfo.ts`，逐步对照 ST 的 `checkWorldInfo`。注意"延迟到递归"的条目只在递归轮触发：如果唯一触发的条目勾了"不递归"，就没有递归轮，它也不会触发（ST 同样如此）。每条都记下原因，在"查看提示词 → 世界书"里看。

### 5.4 SillyTavern 字段映射

**导入角色卡时一并生成她的小世界**（M1）：
- 从角色卡的描述、场景（scenario）和内嵌世界书里，找出她住哪、在哪读书或工作、常去哪，套一个最接近的世界模板（校园 / 城市 / 古风……），生成地点和作息。
- 世界书里提到的其他人（室友、同学、家人、导师）也一起建出来，记下名字、和她的关系、出处。
- 这些人会出现在她的作息和聊天里，比如"室友今天又借我充电器"。
- 导入页先给出识别结果，导入后地点和人都能改。

**角色卡**（PNG 的 tEXt 块：读取时优先 `ccv3`，其次 `chara`；导出时两种都写）

| ST 字段 | 本 App | 说明 |
|---|---|---|
| `name` / `nickname` | `name` | |
| `description` `personality` `scenario` | `card.*` | |
| `first_mes` / `alternate_greetings` | `card.firstMes` / `card.alternateGreetings` | 新开聊天时可左右切换 |
| `mes_example` | `card.mesExample` | `<START>` 分段 |
| `system_prompt` / `post_history_instructions` | `card.systemPrompt` / `card.postHistoryInstructions` | 预设里可选是否让角色卡覆盖 |
| `creator_notes` `tags` `creator` `character_version` | `card.*` | |
| `character_book` | 拆成独立世界书 + `lorebookIds` | 导出时重新嵌回 |
| `extensions.depth_prompt` | 深度注入 | |
| `extensions` 其余、V3 `assets` 等 | 原样保存 | 保证导出不丢字段 |

**世界书条目**

| ST | 本 App |
|---|---|
| `key` / `keysecondary` | `keys` / `secondaryKeys` |
| `selectiveLogic` 0 / 1 / 2 / 3 | `and_any` / `not_all` / `not_any` / `and_all` |
| `position` 0 / 1 / 2 / 3 / 4 / 5 / 6 | `before_char` / `after_char` / `an_top` / `an_bottom` / `at_depth` / `em_top` / `em_bottom` |
| `constant` `disable` `order` `depth` `probability` `scanDepth` | 同名字段（`enabled` = `!disable`） |
| `group` `preventRecursion` `excludeRecursion` `sticky` `cooldown` `delay` `role` | 同名字段 |

**Chat Completion 预设**
- `prompts[]` + `prompt_order`（优先 `character_id` 100001，其次 100000）→ `blocks`，数组顺序即拼装顺序。
- `marker: true` 的块：ST 的 `main / worldInfoBefore / charDescription / charPersonality / scenario / worldInfoAfter / personaDescription / dialogueExamples / chatHistory / jailbreak` 一一对应。导入时自动在"聊天记录"附近补上本 App 的 `memory / environment / sceneRules`。
- `injection_position = 1`（in-chat）→ `injection.position = 'absolute'` + `depth`。
- 采样参数：`temperature top_p top_k frequency_penalty presence_penalty openai_max_tokens openai_max_context stream_openai`。
- 正则脚本：在用户输入 / AI 输出上执行。

**聊天记录**：ST 的 `.jsonl`（第一行是元数据，之后每行一条消息，含 `swipes` / `swipe_id`）可以导入，也可以导出。

---

## 6. 记忆系统

| 层 | 内容 | 存储 |
|---|---|---|
| 短期 | 最近 N 条（按 token 预算） | messages |
| 中期 | 滚动章节摘要（每约 30 条压缩一段） | chapter summaries |
| 长期 | 记忆条目：类型、内容、重要度 1–10、时间、来源消息、向量、状态 | memories |
| 待跟进 | 带 `dueAt` 的记忆，到期由主动消息去问 | memories(type=followup) |
| 日记 | 每晚用角色口吻写当天日记，也是情景记忆 | diaries |
| 关系状态 | 好感、心情、称呼、纪念日、里程碑 | character.relationship |

### 6.1 检索（本机）
- 打分：`score = 0.6 × 相似度 + 0.2 × e^(−天数/半衰期) + 0.2 × 重要度/10`，半衰期默认 30 天。
- 必带：置顶的记忆、到期的待跟进。
- 剩余按分数取 Top-K（默认 8），总长不超过记忆 token 预算。
- 被检索到时 `recallCount + 1`，用于以后调权重。

### 6.2 向量
- 每条记忆存 `{ model, dims, data: float16 base64 }`。1024 维约 2 KB；5000 条约 10 MB，随同步下发。
- 只比较和当前设置同一个模型的向量。换模型后在后台全部重算，并显示进度（"API 与智能体"页有按钮）。
- 手机上暴力计算余弦：5000 × 1024 约 500 万次乘加，十几毫秒。
- 不用 Cloudflare Vectorize：免费额度大约只能存 5000 条 1024 维向量，还要和 D1 保持一致。

### 6.3 夜间整理（Worker，每天 04:00）
合并重复、冲突以新的为准（旧的标 `superseded`）、低价值的衰减归档、写昨天的日记、更新关系状态、排今天的计划。

### 6.4 记忆本（用户可控）
查看、搜索、按类型筛选、置顶、编辑、"忘掉这件事"（删除并在之后的总结里排除）。

---

## 7. 主动消息

### 7.1 规则（默认值，`DEFAULT_PROACTIVE_RULES`）

| 规则 | 时段 | 冷却 | 概率 | 可来电 |
|---|---|---|---|---|
| 早安 | 07:00–09:30 | 12h | 100% | |
| 叫醒来电 | 起床时间 | 12h | 100% | ✓ |
| 早饭 / 午饭 / 晚饭 | 各饭点窗口 | 2–3h | 80–90% | |
| 久坐提醒 | 09:30–21:00 | 2.5h | 60% | |
| 天气变化 | 随时 | 6h | 100% | |
| 待跟进到期 | 随时 | 1h | 100% | |
| 想你了 | 随时 | 4h | 50% | ✓ |
| 催睡 / 晚安 | 23:00–02:00 | 1h | 90% | ✓ |
| 运动夸夸 | 有新运动记录 | 1h | 100% | |
| 学习打卡 | 默认关 | 12h | 70% | |
| 纪念日 | 当天 | 24h | 100% | ✓ |

**饭点逻辑**：窗口内还没记录吃饭，先暗示（"我有点饿了…你吃了吗？"）；超时再正式邀约。

**出门 / 到家**（M3，需要定位；先只做前台）：
- 打开 App 时看一眼你在哪：
  - 你不在家，她会问一句"出门了？去哪呀"，或者顺手推荐一个附近可以带她去的地方；
  - 你刚回家，她会来一句"到家了吗"。
- 不做后台定位和地理围栏；以后要做，也只在安卓壳里，并且要你单独打开。

### 7.2 闸门
依次检查：
- 勿扰时段；
- 每日上限；
- 你 20 分钟内刚聊过；
- 正在学习 / 哄睡；
- 同一规则冷却中；
- 连续两条没理会就退避。

**性格**：粘人 ×1.3 概率，没回复 30 分钟追发一次；适中 ×1；独立 ×0.6，不追发。

### 7.3 推送通道

| 设备 | 主通道 | 备用 |
|---|---|---|
| iPhone 主屏 PWA | Web Push（走 APNs，国内可用，iOS 16.4+，需添加到主屏幕） | Bark |
| 安卓 APK | 精确闹钟（按今天的计划）+ WorkManager 每 15 分钟轮询 `/v1/inbox`，出本地通知 / 全屏来电 | ntfy / webhook |
| 电脑浏览器 | Web Push（Edge 走微软通道，国内可用；Chrome 依赖 FCM，不稳） | webhook |
| 所有设备 | 打开 App 时补齐 | — |

- **webhook 通道**：Bark、ntfy、PushPlus、Server酱、企业微信、钉钉都归为一种，即"按模板发一个 HTTP 请求"，模板里的密钥只存在 Worker。
- **锁屏显示**：完整内容 / 只显示名字 / 隐藏。

### 7.4 AI 来电
- **触发**：Touchpoint 的 action 为 `call`，或回复里有 `[call]`。
- **响铃**：
  - 安卓：全屏来电（full-screen intent）；
  - iPhone：推送，点开进来电界面；
  - App 内：顶部横幅。
- **未接**：生成"未接来电"卡片，再追一条消息。

---

## 8. 环境感知

| 字段 | 来源 |
|---|---|
| 时间、时段（清晨…深夜）、星期 | 设备时钟 + 你的时区（Worker 端按时区换算，Cron 是 UTC） |
| 节气、农历 | lunar-javascript（M0 用近似表：`packages/shared/src/environment.ts`） |
| 法定节假日、调休 | 年度表（例如 chinese-days 数据） |
| 天气：当前、未来 24 小时、预警 | 和风天气（国内准，需要 key 和你的 API Host；由 Worker 代取，缓存 30 分钟）或 Open-Meteo（免 key） |
| 家、你在哪 | 家的地址在"环境与作息"里填（只存本机，Google 地理编码成坐标）；你在不在家、离家多远来自定位。天气和时区默认跟着家的位置 |
| 今日活动 | 步数 / 运动、三餐、学习、昨晚睡眠、听歌（§9） |
| 她在哪、在做什么 | 她自己小世界里的位置，按她的作息走（M3 由主动消息的 Cron 顺便推进）；你带她出门时暂时在你那边。显示在消息页、地图和聊天顶栏，也写进【当前环境】（例如"苏晚在她的小世界里的图书馆（自习中）；你在家"） |
| 设备状态（安卓） | 电量；深夜还亮着屏 |

注入格式（每轮一行，`formatEnvironmentBlock`）：

```
【当前环境】2026-11-09 周一 21:30（夜里） · 立冬后第 2 天 · 上海 小雨 12°C，明天降到 6°C · 你今天走了 8,432 步，午饭吃了拉面，晚饭还没记录 · 距上次聊天 3 小时 · 苏晚在图书馆（自习中）
```

---

## 9. 场景

**通用框架**：每个场景在 `packages/shared/src/scenes.ts` 里声明：
- 名称、图标、背景 key、环境音；
- 默认服装和姿势、氛围色；
- 提示词片段、允许的控制标签、相关的主动规则、数据来源。

**两种世界**（`packages/shared/src/locations.ts`）：

- **每个角色有自己的虚拟小世界**（`World`）：一张小地图，片区、地点、底图都是这个角色专属的。
  - 苏晚的世界：小公寓（卧室、餐桌、客厅、沙发）、学校（图书馆、食堂、操场、游泳馆）、城里（咖啡店、美术馆、电影院、夜市、游乐园、水族馆、江边步道、海边）。
  - 江屿的世界：宿舍、体育学院（田径场、游泳馆、力量房、食堂、自习室）、江边（夜宵摊、老影院、电玩城、江堤、旧码头）。
  - 每个地点写明背景、室内还是室外、在那里能做的事，例如图书馆 → 陪伴学习，咖啡店 → 约会或一起自习。
  - 底图是数据（矩形、路径、椭圆），按主题配色上色；导入新角色时可以选一个世界模板，或让她借用默认世界。
  - 她此刻在哪由她的作息决定（`Character.locationId`），她的头像标在她的世界里。
- **你在真实世界**：用 Google 地图。
  - 内容：家、你此刻在哪、附近可以带她去的地方。
  - 附近的地方来自 Google Places（咖啡店、餐厅、公园、健身房、图书馆），种类决定能一起做什么。
  - 这些真实地点在运行时登记进同一个地点表（`registerPlaces`），聊天、场景、提示词都认得。

**三种"在一起"**：你的人和要做的事永远在真实世界（真的在学、真的在吃），她的生活在她的世界里，"一起"就是把两边接起来。

| 方式 | 你 | 她 | 像什么 | 默认用在 |
|---|---|---|---|---|
| 连线 `remote` | 在你那儿 | 在她世界里做这件事的地方 | 开着视频各做各的 | 学习、吃饭、运动、哄睡、听歌 |
| 去她那 `visit` | 人在你这儿，画面进她的世界 | 在她的世界 | 去她学校找她、坐她旁边 | 约会、戳戳乐 |
| 带她来 `bring` | 在真实世界的某个地方 | 在你身边（手机里） | 出门戴着耳机带上她 | 点了"我的世界"里的地点 |

- 场景页顶栏显示是哪种方式（"连线 · 你在家"），连线和去她那可以随时切换（`Chat.togetherMode`）。
- 聊天里的分隔条也按方式写：
  - 连线："和苏晚连线 · 陪伴学习 · 你在家，她在图书馆" …… "结束连线 · 学了 50 分钟"；
  - 去她那："和苏晚来到电影院 · 约会"；
  - 带她来："带苏晚去街角咖啡店 · 约会"。
- 怎么选由 App 建议：
  - 你在真实的图书馆、餐厅（打开 App 时定位到）→ 建议带她来；
  - 她按作息正好在图书馆、食堂 → 建议连线；
  - 你点她世界里的地点 → 连线（约会、戳戳乐是去她那）。

**她自己的生活**（`World.schedule`、`World.life`）：
- 每个角色有一张作息表，几点在哪、在做什么，和你用同一个时间，这样饭点、睡觉才对得上：
  - 苏晚：白天在图书馆写论文，傍晚去江边散步，晚上再回图书馆自习；
  - 江屿：六点晨跑，下午训练，晚上加练。
- 打开 App 时按作息算出她们此刻在哪（M3 起由 Worker 的 Cron 推进并同步）。
- 她也有自己的任务和三餐。连线自习时她在写"宋词里的雨"，饭搭子时她在吃食堂的麻辣烫，所以"一起"是双向的，她不是一直在等你。
- 她世界里的其他人（室友、同学、导师），在导入角色卡时一并生成（见 §5.4）。

**我们的足迹**：你在真实世界里和她们一起待过的地方，包括连线时你在哪、带她们去过哪。这些地点在"我的世界"地图上带一颗小心，下面列出最近一起做了什么。

**地图页**：上面一排切换"苏晚的世界 / 江屿的世界 / 我的世界"（`?world=`）。
- 在她的世界里：
  - 点地点 → 在那里能和她做什么 → 进入场景（默认连线：你在你那儿，她在这里）；
  - "一起做点什么"的大按钮 → 选她世界里的哪个地方；
  - 点头像 → 去找她 / 发消息 / 打电话。
- 在我的世界里：
  - 点附近的地方 → 选带谁、做什么 → 她"来你这边"陪你（聊天里记"带苏晚去街角咖啡店 · 约会"）；
  - 这时她的世界里显示"她现在在你那边"，离开后她回到自己的世界。
- 从聊天的 ＋ 面板直接进场景时，去她世界里做这件事的默认地点（`defaultLocationFor`）。
- 没填 Google 地图 Key 时，我的世界显示示意图（同一套地图组件画几条街），附近地点用演示数据。

**Google 地图接入**（M3）：
- 在"连接"里加一个 Google 地图连接，Key 只存本机，并在 Google Cloud 里按 App 包名 / 网址限制。
- 用到三个接口：
  - Geocoding：设置家时把地址换成坐标，只调一次，结果缓存；
  - Places API (New) 附近搜索：按种类找附近的地方，结果缓存一天；
  - Maps JavaScript API：画真地图，你和带出门的她标在上面。
- 定位先只做前台：打开 App 时取一次（网页定位；安卓壳里用系统定位），不做后台定位和地理围栏。
- 接口统一放在 `services/types.ts` 的 `MapsClient`，所以以后换高德等地图服务时，页面不用改。

**消息按人分**：一个角色只有一条聊天。场景不另开会话，而是这条聊天里的一段：
- 开始时插一条分隔（例如"和苏晚连线 · 陪伴学习"），结束时插一条（例如"结束连线 · 学了 50 分钟"）。用的是 `MessagePart` 的 `scene` 类型，记着方式 `mode` 和你在哪 `youAt`，在聊天里显示成分隔条。
- 进来后什么都没发生就离开：两条都撤掉，她也回到原来的地方，不留痕迹。
- 在场景里点她的那句话，可以去聊天接着聊，这时还算在一起：
  - 聊天顶栏显示"你们在图书馆"，剧场背景也换成图书馆；
  - 去别的页面才算离开。
- 会话上记着三件事：`togetherAt`（她那边在哪）、`togetherMode`（怎么在一起）、`currentScene`（在做什么）。提示词组装据此带上两边的位置、场景规则和可用标签。

界面用 `SceneShell`（背景 + 立绘 + 顶栏 + 她的一句话 + 底部面板）：
- 背景和标题跟着地点走，例如"咖啡店 · 一起自习"；家里按房间选背景；
- 每个场景只写自己的面板（`apps/web/src/scenes/*`）。

### 9.1 一起运动（`ExerciseScene.vue`）
- **玩法**：选跑步 / 散步 / 骑行，开始后显示计时、距离、配速、步数。她每公里语音打气，结束后生成运动卡片发进聊天。
- **数据**：
  - App 内：计时 + GPS。安卓用前台服务，锁屏不断。
  - 安卓计步传感器 / Health Connect：国内手机上 Health Connect 不常见，以计步传感器为主。
  - iPhone 快捷指令：定时或运动结束时把健康数据 POST 到 `/v1/ingest/workout`。
  - 运动截图：Keep、华为、小米运动截图交给视觉模型识别。
- **AI 行为**：发现新的运动记录就夸或吐槽；久坐提醒；邀约"今晚一起去跑步？"

### 9.2 一起吃饭（`MealScene.vue`）
- **饭搭子（默认，连线）**：各吃各的，但同时开饭。
  - 饭点前她先暗示："我准备去食堂了，你中午吃什么？"
  - 开饭时你拍一张你的饭，识图认出是什么；她也"拍"一张她那边的（她的三餐写在 `World.life`，正式版用生图画出来）。
  - 可以碰个杯，边吃边聊；吃完记一顿，她记住你的口味，也记得你没吃早饭。
- **带她去吃**：她从你家附近真实的餐厅里挑（Google 地图），吃饭时坐你对面，这家店进足迹。
- **去她那吃**：她在她的住处给你做饭，你在现实里吃你的。
- 江屿版：运动员食堂，盯你的蛋白质。
- **数据**：三餐时间窗口（环境与作息页）、饭照（视觉模型）。
- **AI 行为**：先暗示后邀约；记住你的口味，下次推荐。

### 9.3 陪伴学习（`StudyScene.vue`）
- **连线自习（默认）**：你在你那儿学，她在她世界的图书馆学，共用一个番茄钟。
  - 面板上方是"她那边"：她在学什么（`World.life.studyTask`）、学了几个番茄；下面是"你这边"的任务。
  - 每个番茄结束各报一下进度，互相监督，不只是她看着你。
  - 她主动约你："三楼靠窗占了两个座，你几点开始？"你在真实的图书馆打开 App，她会说"你也在图书馆？那我们算同桌了"。
- **坐她旁边（去她那）**：画面进她的图书馆，她就在你旁边。
- **带她来**：你在真实的咖啡店、图书馆，她坐你对面。
- **玩法细节**：番茄钟（25 / 5 分钟）、任务清单、白噪音。专注时她安静地陪着、不说话，休息时才聊。
- **感知**：专注中离开 App（`visibilitychange`），回来时她轻轻提醒一句，并记一次走神。
- **记录**：番茄数、时长、连续天数 → 学习打卡规则。

### 9.4 哄睡（`SleepScene.vue`）
- **玩法**：四种模式——聊天（低语短句）、睡前故事（她现编）、白噪音混音（雨、炉火、海浪、风扇）、呼吸引导（4-7-8）。
- **定时**：到点声音渐弱，她也睡着。可以熄灯。
- **叫醒**：第二天按起床时间来电。
- **平台**：
  - 安卓用前台媒体服务、精确闹钟（叫醒用 `setAlarmClock`）和全屏来电；
  - iPhone 的 PWA 锁屏后 JS 和 WebAudio 会暂停，长音频只能用单个 `<audio>` 元素，效果有限。

### 9.5 一起听歌（`MusicScene.vue`）
- **数据**：网易云模块并入 Worker（`/v1/music/*`）：
  - cookie 存成 secret；
  - 歌曲地址约 20 分钟过期，播放前现取、出错重取；
  - http 链接改成 https；
  - 必要时带 `X-Real-IP`（国内 IP），减少境外出口被地区限制。
- **歌词**：用 `parseLrc`（`packages/shared/src/lrc.ts`）。修掉了 Netease_url 自带解析器的问题：毫秒精度、一行多个时间戳、跳过 JSON 署名行、合并译文。
- **AI 行为**：按当前歌词偶尔发一句"弹幕"（20 字以内），不是每句都评；用 `[music:]` 推荐下一首；记住你的口味。
- **安全**：Netease_url 仓库里提交过一个像真的 `MUSIC_U`，应到网易云退出登录让它失效。

### 9.6 约会（`DateScene.vue`）
- **地点**：
  - 从地图上点了地点就直接开始；
  - 从聊天进来先选地点，她会按天气推荐（下雨推荐室内）。
- **玩法**：像视觉小说一样推进：旁白 + 台词 + 选项（`[choice:]`）。最浪漫的时刻 `[cg:]` 出一张图。
- **结束**：生成"约会回忆"，存进回忆和时间线；聊天里这一段以"离开水族馆 · 约会回忆存好了"收尾。

### 9.7 戳戳乐（`PokeScene.vue`、`composables/usePoke.ts`）
- **交互**：单击戳、长按摸头；1.2 秒内连击 6 下她会生气。
- **反馈**：
  - 即时（零延迟）：表情 + 震动 + 本地台词池；
  - 每 4 下或长按一次：往聊天记一条"你拍了拍她的头"，让 AI 给出更丰富的反应。
- **热区**：在立绘编辑页画，坐标相对立绘框（0–1），换图分辨率不用重画。

### 9.8 语音通话（贯穿所有场景，`CallPage.vue`）
见 §11。

---

## 10. 立绘与 NovelAI

### 10.1 立绘套装
- **组成**：服装 × 姿势 × 表情；按 `{服装}_{姿势}_{表情}.webp` 批量导入。
- **缺图回退**（`resolveSprite`）：同服装同姿势 neutral → 同服装默认姿势 neutral → 默认服装 neutral。
- **默认服装**：场景决定（运动服、睡衣、约会装……）。
- **兼容 ST 表情文件夹**：ST 的 28 个分类标签映射到本 App 的表情：

| 本 App 表情 | ST 标签 |
|---|---|
| 平静 | neutral |
| 微笑 | admiration、approval、caring、gratitude、optimism、relief、pride |
| 大笑 | joy、amusement、excitement |
| 脸红 | love、desire |
| 害羞 | embarrassment、nervousness |
| 嘟嘴 | disgust、annoyance |
| 惊讶 | surprise、realization、confusion、curiosity、fear |
| 难过 | sadness、grief、disappointment、remorse |
| 生气 | anger、disapproval |

- **提示词**：只把有图的表情写进提示词。
- **切换**：表情交叉淡化 260ms；立绘预加载，用 `img.decode()` 避免闪烁。

### 10.2 NovelAI
- **调用**：Worker 代理 `POST https://image.novelai.net/ai/generate-image`。
  - 模型 `nai-diffusion-4-5-full`；
  - V4 起用 `v4_prompt`（多人时用 `char_captions`）；
  - 返回 zip，Worker 解出 PNG 存 R2。
- **提示词**：外观基础 tags + 负面 tags 来自角色卡，生图提示词智能体补动作 / 服装 / 场景。
- **尺寸**：竖版 832×1216、横版 1216×832。不超过约 1024² 像素、≤28 步，Opus 订阅免点数。
- **一致性**：可选 vibe transfer / 角色参考。
- **相册**：保存提示词、种子、模型，可以"用同样参数重画"。

---

## 11. 语音

### 11.1 接口（按角色配置音色）
- **TTS**：
  - OpenAI 兼容 `/audio/speech`（硅基流动 CosyVoice、各家中转）、MiniMax、Fish Audio、自建 GPT-SoVITS；
  - Edge TTS 可选，经 Worker；
  - 安卓系统 TTS 兜底。
  - 处理：表情映射成情绪参数；朗读前去掉（动作描写）和 emoji；按文本哈希缓存音频。
- **STT**：OpenAI 兼容 `/audio/transcriptions`（Whisper、SenseVoice），安卓系统识别兜底。

### 11.2 通话管线与延迟预算

| 步骤 | 目标 |
|---|---|
| 检测你说完（VAD，silero / `@ricky0123/vad-web`） | 0.3–0.5 秒 |
| 语音识别（短句） | 0.3–0.6 秒 |
| 主对话首 token（用"通话 · 短句"预设） | 0.4–1.0 秒 |
| 凑够第一句 | 0.2–0.4 秒 |
| TTS 首段 | 0.3–0.6 秒 |
| **首句出声** | **约 2 秒** |

- **打断**：她说话时检测到你开口，立刻停止播放、取消生成，保留已说的部分。
- **字幕**：边播边出。
- **通话记录**：生成卡片进聊天，并参与记忆总结。
- **平台差异**：
  - iPhone：锁屏后中断，只能前台通话；
  - 安卓：前台服务（麦克风 + 媒体播放）保证锁屏不断。

---

## 12. 数据模型与同步

### 12.1 领域类型
在 `packages/shared/src/types/*`，客户端和 Worker 共用。这个包不依赖 DOM 和 Node，可以原样放进 Worker。

- **角色与配置**：Character（含 ST 字段、外观 tags、语音、主动配置、关系状态、此刻所在地点 `locationId`、界面里的称呼 `pronoun`：她 / 他 / TA，导入的卡没有这一项，要自己选）、Persona、Lorebook / LoreEntry、Preset / PromptBlock、SpriteSet / PokeHotspot。
- **对话**：
  - Chat：一个角色一条；`togetherAt` / `currentScene` 记你们此刻在哪、在做什么；`background` 是这个聊天单独的背景（ChatBackground：图片 key、遮罩、模糊）；
  - Message：parts 有文字 / 语音 / 图片 / 歌曲 / 拍一拍 / 通话记录 / 运动 / 饭照 / 学习 / 约会 / 礼物 / 场景分段；还有 swipes。
- **地点**：MapLocation（`locations.ts`，地图坐标、背景、在那里能做的事）。
- **记忆**：Memory（带向量）、ChapterSummary、DiaryEntry。
- **活动**：ActivityLog（运动 / 步数 / 吃饭 / 学习 / 睡眠 / 听歌 / 约会）。
- **API**：按功能分。AgentRoute（每个功能一条：自己的 FeatureApi = 渠道 + 地址 + 模型，可选的备用 FeatureApi，文本功能可以跟随主对话）；Key 不在记录里，按 `api:{功能}` 存在本机。
- **主动与设置**：ProactiveRule、Touchpoint、PushChannel、AppSettings（外观里有模式、白天 / 夜里配色、点缀色来源、通用聊天背景）。

所有可同步记录都带 `id / createdAt / updatedAt / deleted / seq`。

### 12.2 D1 建表草案

```sql
-- 所有可同步记录放一张表：同步逻辑统一；按 kind + parent 建索引，满足 Cron 查询
CREATE TABLE records (
  kind       TEXT NOT NULL,          -- character / chat / message / memory / lorebook / preset / activity …
  id         TEXT NOT NULL,
  parent_id  TEXT,                   -- message→chatId，memory→characterId …
  seq        INTEGER NOT NULL,       -- 服务器分配，全局递增
  updated_at INTEGER NOT NULL,       -- 客户端时间，只用于同一条记录并发编辑时的"后写者赢"
  deleted    INTEGER NOT NULL DEFAULT 0,
  device_id  TEXT,
  data       TEXT NOT NULL,          -- JSON，永远不含 Key
  PRIMARY KEY (kind, id)
);
CREATE UNIQUE INDEX idx_records_seq ON records(seq);
CREATE INDEX idx_records_parent ON records(kind, parent_id, updated_at);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- next_seq、schema_version
CREATE TABLE blobs (hash TEXT PRIMARY KEY, mime TEXT, size INTEGER, created_at INTEGER);
CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT, platform TEXT, token_hash TEXT, last_seen INTEGER, cursor INTEGER);
CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, device_id TEXT, kind TEXT, endpoint TEXT, keys TEXT, enabled INTEGER, last_ok_at INTEGER);
CREATE TABLE secrets (connection_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, updated_at INTEGER); -- AES-GCM，KEK 在 Worker secret
CREATE TABLE touchpoints (id TEXT PRIMARY KEY, character_id TEXT, rule_id TEXT, due_at INTEGER, status TEXT, data TEXT);
CREATE INDEX idx_tp_due ON touchpoints(status, due_at);
CREATE TABLE usage (date TEXT, agent TEXT, tokens INTEGER, PRIMARY KEY (date, agent)); -- 后台智能体每日 token 预算
```

### 12.3 同步协议
- **拉取**：`GET /v1/sync/pull?since=<seq>&limit=500` → `{ records, next, more }`。第一次同步分页拉。
- **推送**：`POST /v1/sync/push`，body 为 `{ deviceId, records: [{ kind, id, parentId, updatedAt, deleted, data }] }`。
  - 服务器在一个 D1 batch 里分配 seq 并写入；
  - 同一条记录被别的设备改得更晚时，保留更新的那份并返回冲突。
- **客户端发件箱**（Dexie）：
  - 失败后指数退避重试（沿用 math-reader 的锁、去重、退避）；
  - 触发时机：启动、回到前台、改动后防抖、每 15 分钟、下拉刷新；
  - 生成回复期间暂停。
- **保护**：
  - 一次删除大量记录需要二次确认；
  - 云端非空时不被本机空数据覆盖；
  - 每天把全量 ndjson 备份到 R2，保留 7 天；
  - 可导出 ZIP。
- **Key 不进同步数据**：
  - 可选"同步密码"：本机派生密钥加密后放进一条 `kind = keyring` 的记录，Worker 只见密文；
  - 交给 Worker 的 Key 走 `/v1/secrets`，只写不读。

---

## 13. Worker（`apps/hub`，M2）

| 路由 | 用途 | 鉴权 |
|---|---|---|
| `POST /v1/auth/login` | 单用户密码登录（复用 math-reader `mcp/src/authorize.ts`：SHA-256 + `timingSafeEqual` + KV 按 IP 限流） | 密码 |
| `POST /v1/auth/pair` | 用一次性配对码（二维码）给新设备发令牌 | 配对码 |
| `GET /v1/sync/pull`、`POST /v1/sync/push` | 增量同步 | 设备令牌 |
| `PUT/GET/HEAD /v1/blob/:sha256` | 素材 | 设备令牌 |
| `POST /v1/relay` | 经 Worker 转发；只允许"连接"里配置过的主机，不是开放代理 | 设备令牌 |
| `PUT /v1/secrets/:connectionId` | 写入交给 Worker 的 Key（只写不读） | 设备令牌 |
| `POST /v1/image/novelai` | 生图（解 zip → R2） | 设备令牌 |
| `GET /v1/music/search｜song｜lyric` | 网易云 | 设备令牌 |
| `GET /v1/weather` | 天气（缓存） | 设备令牌 |
| `POST /v1/ingest/:kind` | 快捷指令 / 安卓上报健康数据 | 单独的上报令牌 |
| `POST /v1/push/subscribe` | Web Push 订阅、webhook 通道 | 设备令牌 |
| `GET /v1/inbox?since=` | 安卓壳轮询：新的主动消息 + 今天的计划 | 设备令牌 |
| `POST /v1/agents/run/:role` | 手动让 Worker 跑一次后台智能体 | 设备令牌 |
| Cron `*/5 * * * *` | 触发到点的 Touchpoint | — |
| Cron `0 20 * * *`（北京时间 04:00） | 规划今天、夜间整理、日记、备份 | — |

- **绑定**：D1 `DB`、R2 `BUCKET`、KV `KV`（只用于登录限流，免费版每天写 1000 次）、Workers AI `AI`（可选）。
- **Secrets**：`AUTH_PASSWORD_HASH`、`KEK`、`VAPID_PRIVATE_KEY`、`NETEASE_COOKIE`、`QWEATHER_KEY`。
- **部署**：同 math-reader `deploy-mcp.yml`，GitHub Actions 执行 `wrangler deploy` + `wrangler secret put`。
- **自定义域名**：必须绑，国内 `*.workers.dev` 常被屏蔽。
- **免费版限制**：
  - 每次请求只有 10ms CPU，等待 API 不算；主动消息循环以 I/O 为主，批量查询 D1；
  - 每个账号最多 5 个 Cron，这里只用 2 个；
  - 超限再升级到 5 美元/月的付费版。
- **存储适配层**：D1 ↔ SQLite、R2 ↔ S3 / 文件系统。以后想迁到国内 VPS，只换适配层。

---

## 14. 安卓壳（`apps/android`，M3）

继承 math-reader 的 `MainActivity`：
- `WebViewAssetLoader` 以 `https://appassets.androidplatform.net/www/` 加载打包的页面，URL 带版本号，响应头 no-store；
- `onRenderProcessGone` 重建；
- 麦克风授权桥接。

**去掉** Boox 专用的 Onyx SDK、笔迹桥、jetifier、HiddenApiBypass。

**新增**：
- **返回键**：页面能后退就 `history.back()`，否则退出。
- **深链**：`onNewIntent`。通知点开后用 `evaluateJavascript` 跳到对应路由。

**JS 桥**：一个对象 `window.AiCompanionNative`，入参出参都是 JSON（`{ ok, code, retryable, … }`，同 math-reader 约定）。

| 方法 | 作用 |
|---|---|
| `getInfo()` | 版本、平台、权限状态 |
| `notify(json)` | 本地通知（渠道：消息 / 来电 / 场景） |
| `scheduleAlarms(json)` | 今天的计划设成精确闹钟（`setExactAndAllowWhileIdle`；叫醒用 `setAlarmClock`）；开机后重设 |
| `startPolling(json)` | WorkManager 每 15 分钟拉 `/v1/inbox` |
| `showIncomingCall(json)` | 全屏来电（运行时检查 `canUseFullScreenIntent`） |
| `media.*` | 前台媒体服务：TTS 队列、白噪音、听歌；MediaSession；定时渐弱 |
| `steps.today()` / `health.read(json)` | 计步传感器 / Health Connect |
| `vibrate(pattern)`、`keepAwake(on)` | 震动、常亮 |
| `speech.listen()` / `speech.speak()` | 系统识别 / 系统 TTS 兜底 |

**权限**：`ACCESS_FINE_LOCATION`（只在前台用，不申请后台定位）、`POST_NOTIFICATIONS`、`SCHEDULE_EXACT_ALARM`、`FOREGROUND_SERVICE(_MEDIA_PLAYBACK / _MICROPHONE)`、`ACTIVITY_RECOGNITION`、`RECORD_AUDIO`、`USE_FULL_SCREEN_INTENT`、`RECEIVE_BOOT_COMPLETED`、`WAKE_LOCK`。

**注意事项**：
- **targetSdk**：侧载 APK 保持 ≤33，避开 Android 14 对前台服务类型、全屏来电、精确闹钟的默认限制。
- **国产 ROM**：引导用户打开自启动、电池无限制、锁屏显示（App 内做一页说明）。
- **网页更新**：先沿用打包方式，稳定、离线可用。以后可加"网页包热更新"。
- **选图片**：上传头像、聊天背景用的是网页的 `<input type="file">`，壳里要实现 `WebChromeClient.onShowFileChooser`（math-reader 的 MainActivity 已有，照搬）。
- **CI**：沿用 `build-apk.yml` → `sign-apk.yml`（受保护环境 + 证书指纹）。构建前先 `pnpm build`，把 `apps/web/dist` 拷进 `assets/www`。

---

## 15. UI 框架（M0 已实现）

| 路由 | 页面 | 文件 |
|---|---|---|
| `#/chats` | 消息列表：一条很小的"她们在哪"（缩略地图 + 每人一行）、会话列表（一个角色一条） | `pages/ChatsPage.vue` |
| `#/chat/:id?mode=im\|stage` | 聊天：IM 气泡 / 剧场立绘（可戳） | `pages/ChatPage.vue` |
| `#/chat/:id/inspect` | 查看提示词 | `pages/PromptInspectorPage.vue` |
| `#/call/:charId(?incoming=1)` | 通话 / 来电 | `pages/CallPage.vue` |
| `#/map?world=&focus=` | 地图：切换每个角色的小世界和"我的世界"（真实世界）；她的位置、此刻建议、能一起做的事；家、附近可以带她去的地方、今天的你 | `pages/MapPage.vue`、`components/map/WorldMap.vue`、`stores/realworld.ts` |
| `#/scene/:sceneId?at=` | 七个场景；`at` 是地图上的地点 | `pages/ScenePage.vue` + `scenes/*` |
| `#/memories?char=&tab=` | 回忆按人分：上面一排头像切换看谁的，下面是关系状态 + 时间线 / 日记 / 相册 / 记忆本 | `pages/MemoriesPage.vue` |
| `#/me` 及 `#/me/*`、`#/import` | 我的、角色卡、人设、世界书、预设、API 与智能体、语音、主动消息、环境与作息、同步、外观、导入 | `pages/MePage.vue`、`pages/me/*` |

- **底部 4 个 Tab**：消息（未读角标）/ 地图 / 回忆（新日记小红点）/ 我的。二级页面不显示 Tab。
- **不出戏**：
  - 消息页只放"像真人"的东西：她们在哪、聊天；
  - 主动消息的排期（今天还会找你几次、下一次几点）只在"我的 → 主动消息"里看；
  - 聊天列表里她先发来的消息也不打"[主动]"标签。
- **窄屏和系统大字体**（例如安卓 320px 宽、字体放大 1.3 倍）：
  - 文字只截断不换行；
  - 剧场顶栏把位置让给"她在哪"；对话框工具条只留图标；
  - 地图上的地点名不被边缘裁掉。
- **主题**（参考 math-reader 的主题设置，在"我的 → 外观"）：
  - 模式：跟随系统 / 夜 / 日。开关只切换 `<html data-theme>`，"跟随系统"时不带它；深色优先（`styles/tokens.css`）。
  - 配色有 6 套：暮紫（默认）、素墨、蓝调、森绿、暖橙、樱粉（`theme/palettes.ts`）。
    - 每套都有白天、夜里两版，跟着模式切换；也可以白天、夜里分开选。
    - 每版只写几种基础色（底色、卡片、输入框、边框、三级文字、点缀色），毛玻璃、遮罩、地图等其余变量按规则算出来，注入到 `<html>`。
    - 默认的暮紫不注入任何变量，直接用样式表。
  - 点缀色默认跟随当前角色：`AccentScope` 用 JS 算好派生色（`utils/color.ts`）再内联注入，并同步给 Vant 主色。不用 CSS `color-mix()`，因为有些国产 WebView 不支持。也可以改成"跟随配色"，用配色自带的点缀色。
  - Vant 变量统一映射到主题变量（`styles/vant.css`），所以换配色时 Vant 组件也跟着变。
- **聊天背景与头像**：
  - 聊天背景：
    - 在外观里设一张通用的；单个聊天在 ⋯ → 聊天背景里另设、关掉，或恢复成跟随通用；
    - 可调遮罩（用配色底色盖一层，气泡更清楚）和模糊。只用在聊天气泡模式；剧场模式还是按地点画背景。
  - 头像：
    - 你和她们的头像都能自己上传，居中裁成正方形；
    - 你上传头像后，聊天里你的消息旁也会显示。
  - 图片处理：
    - 在本机压缩：背景长边 1440px，头像 320px，优先 WebP（iOS 退回 JPEG）。
    - 骨架阶段存在 localStorage（`stores/appearance.ts`）；
    - M1 起存 IndexedDB，按内容哈希传 R2，随 `Chat.background`、`Character.avatar`、`Persona.avatar` 同步。
- **占位美术**：
  - 立绘是 SVG 简笔画，11 种表情、5 套服装、5 种姿势（`components/figure/CharacterFigure.vue`）；
  - 背景按场景和时段画（`SceneBackdrop.vue`）；
  - 导入真立绘、真背景后自动替换。
- **服务接口**：在 `services/types.ts`，界面只依赖接口。对话、语音合成、向量化、生图的实现在 `services/ai.ts`（交给 `packages/ai` 的多智能体）：智能体有可用连接时真的调用，否则退回假实现（`services/mock/*`），假模型会流式吐控制标签，演示换表情、发歌、要配图、来电。语音识别、音乐、天气、地图、同步、推送仍是假实现。
- **预览**：`pnpm build:preview` 用内存路由 + 单文件打包，生成可发布的预览页（`scripts/make-artifact.mjs`）。

---

## 16. 安全与隐私

- **Key 分三档，按连接设置**：
  - 只在本机（默认，永不进同步数据）；
  - 交给 Worker（AES-GCM 加密存 D1，KEK 在 Worker secret；只写不读，只有后台智能体和"经 Worker 转发"会用）；
  - 无需 Key。
- **设备间同步 Key**（可选）：用你自己的同步密码在本机派生密钥加密，Worker 只存密文。
- **登录**：单用户密码换设备令牌，D1 只存令牌哈希；登录失败按 IP 限流；新设备扫码配对。
- **转发**：只允许"连接"里配置过的主机，不做开放代理。原 Netease_url Worker 是 `ACAO: *` 且无鉴权，并入中枢后加鉴权。
- **网易云 cookie**：只存 Worker secret。
- **通知**：锁屏可以只显示名字或完全隐藏。
- **家的地址和位置**：
  - 家的地址只存在你的设备，随同步只进你自己的 Worker；
  - 不写进代码仓库，也不发给对话模型，模型只知道"你在家 / 出门了 / 离家多远"；
  - 打开地图时，坐标会发给 Google，这是用 Google 地图绕不开的；
  - 定位只在打开 App 时取一次，不在后台定位。
- **数据**：全部在你自己的 Cloudflare 账号里，随时导出（ZIP / SillyTavern 格式）。不接任何第三方统计。

---

## 17. 风险与待定

**风险**

| 风险 | 对策 |
|---|---|
| 国内网络：`*.workers.dev`、Google 服务不可用 | 自定义域名；不依赖 FCM / Google Fonts / 外部 CDN |
| iPhone PWA：锁屏暂停、无全屏来电、无计步、主屏 App 与 Safari 存储分开 | Web Push + Bark；快捷指令上报健康数据；设置在主屏 App 里做 |
| Cloudflare 免费版限制 | 检索放本机；批量查询；必要时 5 美元/月 |
| 模型费用 | 每个后台智能体有每日 token 上限；总结批量做；Worker 有总开关 |
| 中转不稳定 | 每个智能体可设备用连接；流式失败自动退回非流式 |
| 国产安卓杀后台 | 精确闹钟 + 轮询 + 打开补发；引导白名单 |
| 网易云地区限制 / 地址过期 | 播放前现取、出错重取；`X-Real-IP`；必要时自建在国内 |
| Google 地图在中国大陆不可用；Places 按次计费 | 地图接口抽象成 `MapsClient`，可换高德等；附近地点缓存一天；没 Key 时用示意图 |

**待定**（需要你决定）
1. 立绘的形式：每个表情一张 PNG，还是分层（身体 + 表情）？各有几套服装、几种姿势？
2. TTS 想用哪家，有没有想要的音色？是否需要训练 / 克隆音色？
3. NovelAI 是什么档位（Opus 才有免点数的小图）？
4. Worker 用哪个域名？需要时是否接受 5 美元/月的付费版？
5. 是否需要 SillyTavern 的正则脚本和 HTML 状态栏（"前端卡"）？
6. 内容尺度与锁屏通知的隐私偏好。
7. 要不要"朋友圈"（她发动态）、群聊这类扩展？
