# ai-mobile

AI 陪伴对话 App：像 SillyTavern 一样用角色卡、世界书、预设聊天，但她会**主动找你**，记得你说过的事，知道现在几点、下不下雨，陪你运动、吃饭、学习、睡觉、听歌、约会，也会打电话给你。

- 设计文档：[`docs/DESIGN.md`](docs/DESIGN.md)
- 当前进度：**M1 进行中**。
  - 已经是真的：导入 SillyTavern 角色卡（PNG / JSON，V1–V3，内嵌世界书自动拆出来绑定）、世界书、Chat Completion 预设；导入的东西和聊天存在本机（IndexedDB），刷新后还在；发消息时按 SillyTavern 的规则拼提示词（预设顺序、世界书扫描、宏、按深度插入、token 预算），"查看提示词"里看到的就是请求体。
  - 也是真的（在"我的 → API 设置"里填了 Key 之后）：多智能体调用（`packages/ai`）。主对话流式回复（自定义 / Claude / OpenAI 兼容 / Gemini / Vertex Agent / DeepSeek，移植自 math-reader），失败自动换备用 API；`[cg:]` 配图走生图提示词 + NovelAI；她的声音走 TTS（硅基流动 CosyVoice / MiniMax / 火山引擎 / Fish Audio / GPT-SoVITS）；向量化（测相似度、重算向量）；"写一段她的番外"。调用失败时显示完整报错（请求地址、状态码、响应头、服务商返回的原文）。设置存在本机，Key 单独存、只在这台设备上。
  - 语音消息：按住录音，松开后上传到配置的语音识别 API（硅基流动 SenseVoice / OpenAI 兼容），真实识别后发消息；录音存在本机，可播放和查看文字。上滑取消、离开聊天会释放麦克风，识别失败显示完整报错，不会代填演示台词。
  - 还是假的：没填 Key 的文本智能体（用演示模型，所以不填也能逛）、语音通话、同步、推送，以及演示角色、记忆、天气、今日活动这些数据。

## 目录

```
apps/web/            前端（Vue 3 + Vite + TypeScript + Pinia + Vue Router + Vant 4 + UnoCSS）
  src/pages/         页面：消息、聊天（IM / 剧场）、通话、地图、场景、回忆、我的、各设置页
  src/scenes/        七个场景的面板（运动、吃饭、学习、哄睡、听歌、约会、戳戳乐）
  src/components/    聊天气泡与卡片、剧场立绘与对话框、场景外壳、小地图、占位立绘 / 背景……
  src/services/      服务接口 + 假实现（假的流式模型会吐 [expr:] 等控制标签）
  src/mock/          演示数据（两个原创角色：苏晚、江屿）
  scripts/           shots.cjs（逐页截图检查）、import-e2e.cjs（导入 + 发送的端到端检查）、make-artifact.mjs（生成预览页）
packages/shared/     前端和以后的 Worker 共用：领域类型、场景注册表、地图地点、控制标签解析、环境描述、LRC 解析
  src/st/            SillyTavern 兼容：PNG 文本块、角色卡 / 世界书 / 预设的导入导出、宏、世界书扫描、提示词拼装
  test/fixtures/     测试用的 ST 预设、JSON 角色卡、PNG 角色卡
packages/ai/         AI 调用层，前端和以后的 Worker 共用（只用 Web 标准接口），说明见 packages/ai/README.md
  src/llm/           文本对话：OpenAI 兼容 / DeepSeek / Claude / Gemini / Vertex Agent（流式、思考内容、流式失败改普通请求、按报错调整参数）
  src/tts/ image/ embedding/   语音合成（含火山引擎声音复刻）、生图（NovelAI、OpenAI 兼容）、向量化
  src/channels.ts    渠道表：每个功能能选哪些渠道、默认地址和常用模型
  src/agents/        多智能体：按功能路由与备用 API、每日上限、番外 / 生图提示词 / 总结的提示词与解析、配图流水线、记忆检索
docs/DESIGN.md       完整设计
```

以后会加 `apps/hub`（Cloudflare Worker + D1 + R2）和 `apps/android`（WebView 壳）。

## 在线试用

部署在 GitHub Pages：https://none0enon.github.io/ai-mobile/ （`.github/workflows/pages.yml`：推到 main 时检查、测试、构建并部署；PR 只做检查）。

- 第一次部署前，在仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
- 可以装成 App（PWA）：iPhone 用 Safari 打开 → 分享 → 添加到主屏幕；安卓用 Chrome 打开 → 菜单 → 安装应用，或者在「我的 → 装成 App」里点安装。装好后全屏打开，断网也能进（AI 请求仍要联网）。
  - 卸载后装不回去：以前 manifest 的 `id` 写的是 `./`，浏览器按站点根目录解析成 `https://none0enon.github.io/`，可能和同一个 github.io 下的其他网页 App 撞在一起；现在是 `/ai-mobile/`。「我的 → 装成 App」里可以清理后台服务和缓存再刷新（聊天、角色、Key 不受影响），也写了各平台还装不上时怎么办。
- 在「我的 → API 设置」里按功能设置：点一个功能（主对话、番外、语音合成、生图……），选渠道、填地址和 Key、选模型（可以拉取列表），点「测试连接」。Key 只存在这台设备的浏览器里，请求从浏览器直接发给服务商。

## 本地运行

需要 Node 22.12+ 和 pnpm 10。

```bash
pnpm install
pnpm dev            # http://localhost:5173
pnpm typecheck      # vue-tsc + tsc
pnpm test           # 单元测试：控制标签、LRC、环境描述、ST 导入 / 世界书 / 宏 / 提示词拼装；AI 调用层（假的服务端）
pnpm build          # 正式构建 → apps/web/dist（hash 路由，可放在任意静态目录）
pnpm build:preview  # 单文件预览页 → apps/web/artifact/index.html
```

逐页截图检查（需要 Playwright，用环境里已安装的版本）：

```bash
cd apps/web && npx vite preview --port 4173 &
node scripts/shots.cjs            # 全部页面，深色
node scripts/shots.cjs chat --light   # 只看名字含 chat 的页面，浅色
node scripts/import-e2e.cjs       # 导入测试用的预设和两张角色卡，发一条消息，核对"查看提示词"
```

## 可以在骨架里试的

- "我的 → 导入 ST 文件"：选一个 Chat Completion 预设、一张角色卡（PNG 或 JSON）。先显示识别结果，确认后导入；角色卡导入后直接去聊天，第一条是开场白。
  - 发一条消息，然后右上角 ⋯ → 查看提示词：能看到发出去的每一条消息、预设每一块发没发和为什么、世界书每一条触发没触发和为什么、请求体 JSON。
  - 预设的开关以 ST 实际生效的那套顺序（`prompt_order` 里的 100001）为准。那套里关掉的块（例如主提示、世界书位置）不会发送，和 SillyTavern 一样。

- 聊天里发"好累""想你""画一张""听歌""约会"：假模型会流式回复，并切换表情、发配图 / 歌曲卡、给选项、发起来电。
- 右上角切到剧场模式，点她的头、脸、肩膀（长按是摸头，连击会生气）。
- "地图"上面切换"苏晚的世界 / 江屿的世界 / 我的世界"：
  - 每个角色有自己的小世界，按作息出现在不同地方。点地点和她一起做事，默认是"连线"：你在你那儿、她在她那儿，各做各的、一起做。
  - 连线自习：共用番茄钟，她也在写她的论文。饭搭子：拍你的饭给她看，她也在吃她那边的饭，还能碰个杯。场景右上角可以切到"坐在她旁边"。
  - 其他场景：运动是加速演示，听歌的歌词会滚动、她会发弹幕。
  - "我的世界"是你的真实世界（接 Google 地图前是示意图）：家、附近可以带她去的地方，带她出门时她会"来你这边"；一起待过的地方记成"我们的足迹"。
  - 家的地址在"我的 → 环境与作息"里填，只存在本机。
- 消息按人分：一个角色只有一条聊天。去过的场景在聊天里是一段"来到… / 离开…"；在场景里点她的话可以去聊天接着聊。
- "我的 → API 设置"：接真实模型，按功能分（不按渠道分）。
  - 文本功能（主对话、番外、总结、生图提示词、主动消息、识图）的渠道：自定义（任意地址，请求格式可选 Gemini / OpenAI / Claude，默认 Gemini，同 math-reader 的自定义渠道）、Claude、OpenAI 兼容、Gemini、Vertex Agent、DeepSeek。番外这些默认跟随主对话，也可以单独设置。
  - 其他功能的渠道：自定义（OpenAI 格式，任意地址）和能做这件事的几家——向量化：硅基流动、Gemini；语音合成：硅基流动、MiniMax、火山引擎、Fish Audio、GPT-SoVITS；生图：NovelAI（含公益站）、硅基流动；语音识别：硅基流动 / 自定义 OpenAI 兼容接口（`/audio/transcriptions`）。硅基流动拉取语音识别模型时按 `speech-to-text` 筛选，连接测试上传本地生成的静音 WAV，不开启麦克风。
  - 每个功能填地址、Key、模型（"拉取模型列表"或手动填），"测试连接"；可以再设一个失败时改用的备用 API；也能照搬别的功能的设置。本机、局域网地址和自建 GPT-SoVITS 可以不填 Key。
  - 测试失败、拉取失败、聊天回复失败都显示完整报错：请求地址（Key 已隐去）、状态码、响应头、服务商返回的原文、底层错误；备用 API 也失败时两边都列出来，可以复制。卡片上写着"已接通"还是"演示模型"以及原因，最近一次调用失败也在卡片上。
  - 以前按连接分的设置（连接 + 主要 / 次要 / 备用 API）第一次打开时自动转过来，Key 跟着搬。番外、总结等后台功能可以设每日 token 上限。
  - 向量化可以测相似度、用新模型重算向量。
  - 主对话填好后，聊天就是真的模型在回；她回复里的 `[cg:…]` 会真的出图（存在本机素材库）；回复失败时气泡下写着原因，可以重新生成。
- "我的 → 语音"：给每个角色选音色、风格（GPT-SoVITS 填参考音频），试听；用的是 API 设置里"语音合成"的渠道。
- "我的 → 试一试 → 写一段她的番外"：你不在的时候她那边发生了什么；可以让她把番外里的那句话发给你，或者把那一幕画出来。
- "我的 → 演示"：模拟一条主动消息、模拟她打来电话。
- "我的 → 外观"（参考 math-reader 的主题设置）：
  - 切换 跟随系统 / 夜 / 日；
  - 选 6 套配色（每套都有白天、夜里两版，也能分开选）；
  - 点缀色跟随角色或跟随配色；
  - 上传聊天背景（可调遮罩、模糊），单个聊天在 ⋯ → 聊天背景里另设；
  - 上传你和她们的头像。
  - 这些设置和图片存在本机浏览器里，刷新后还在。
