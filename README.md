# ai-mobile

AI 陪伴对话 App：像 SillyTavern 一样用角色卡、世界书、预设聊天，但她会**主动找你**，记得你说过的事，知道现在几点、下不下雨，陪你运动、吃饭、学习、睡觉、听歌、约会，也会打电话给你。

- 设计文档：[`docs/DESIGN.md`](docs/DESIGN.md)
- 当前进度：**M0 界面骨架**。所有页面和导航都有，数据都是演示用的假数据，还没有接真实的 AI / 同步 / 推送。

## 目录

```
apps/web/            前端（Vue 3 + Vite + TypeScript + Pinia + Vue Router + Vant 4 + UnoCSS）
  src/pages/         页面：消息、聊天（IM / 剧场）、通话、地图、场景、回忆、我的、各设置页
  src/scenes/        七个场景的面板（运动、吃饭、学习、哄睡、听歌、约会、戳戳乐）
  src/components/    聊天气泡与卡片、剧场立绘与对话框、场景外壳、小地图、占位立绘 / 背景……
  src/services/      服务接口 + 假实现（假的流式模型会吐 [expr:] 等控制标签）
  src/mock/          演示数据（两个原创角色：苏晚、江屿）
  scripts/           shots.cjs（逐页截图检查）、make-artifact.mjs（生成预览页）
packages/shared/     前端和以后的 Worker 共用：领域类型、场景注册表、地图地点、控制标签解析、环境描述、LRC 解析
docs/DESIGN.md       完整设计
```

以后会加 `apps/hub`（Cloudflare Worker + D1 + R2）和 `apps/android`（WebView 壳）。

## 本地运行

需要 Node 22.12+ 和 pnpm 10。

```bash
pnpm install
pnpm dev            # http://localhost:5173
pnpm typecheck      # vue-tsc + tsc
pnpm test           # 控制标签、LRC、环境描述的单元测试
pnpm build          # 正式构建 → apps/web/dist（hash 路由，可放在任意静态目录）
pnpm build:preview  # 单文件预览页 → apps/web/artifact/index.html
```

逐页截图检查（需要 Playwright，用环境里已安装的版本）：

```bash
cd apps/web && npx vite preview --port 4173 &
node scripts/shots.cjs            # 全部页面，深色
node scripts/shots.cjs chat --light   # 只看名字含 chat 的页面，浅色
```

## 可以在骨架里试的

- 聊天里发"好累""想你""画一张""听歌""约会"：假模型会流式回复，并切换表情、发配图 / 歌曲卡、给选项、发起来电。
- 右上角切到剧场模式，点她的头、脸、肩膀（长按是摸头，连击会生气）。
- "地图"里点地点、选和谁一起去，进各个场景：运动是加速演示；学习的番茄钟会走；听歌的歌词会滚动、她会发弹幕。
- 消息按人分：一个角色只有一条聊天。去过的场景在聊天里是一段"来到… / 离开…"；在场景里点她的话可以去聊天接着聊。
- "我的 → API 与智能体"：每个智能体选连接和模型，向量化可以测相似度、重算向量。
- "我的 → 演示"：模拟一条主动消息、模拟她打来电话。
- "我的 → 外观"：切换夜 / 昼主题。
