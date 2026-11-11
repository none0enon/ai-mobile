# Cloudflare 主动消息

`apps/hub` 实现设计 §3.2 / §7 的云端链路：Cron 每 5 分钟按用户 IANA 时区排期、检查闸门、在触发时用角色卡/所选预设/世界书/最近聊天生成消息，先持久化到 D1，再推送。所有 App 窗口关闭后仍运行。

各角色/到期任务以 `Promise.allSettled` 并发运行，没有全局串行队列。D1 原子领取的是单条 Touchpoint；稳定消息 ID 和唯一约束防止 Cron 重叠、客户端重开或模型重试造成重复消息。云端模型和推送分别重试，推送失败不会重新调用模型。

## 部署一次

需要 Node 22.22+、pnpm（版本见根 package.json），以及自己的 Cloudflare 账号。命令在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @app/hub exec wrangler login
pnpm --filter @app/hub exec wrangler d1 create ai-mobile-hub
```

把返回的 database_id 和 account_id 填入环境变量（ID 不是密钥）：

```sh
export HUB_D1_ID='数据库 UUID'
export CLOUDFLARE_ACCOUNT_ID='账号 ID'
node apps/hub/scripts/configure.mjs
pnpm --filter @app/hub exec wrangler d1 migrations apply ai-mobile-hub --remote --config wrangler.deploy.json
pnpm --filter @app/hub exec wrangler deploy --config wrangler.deploy.json
node apps/hub/scripts/create-secrets.mjs "$PWD/apps/hub/hub.secrets.json" 'mailto:你的联系邮箱'
pnpm --filter @app/hub exec wrangler secret bulk hub.secrets.json --config wrangler.deploy.json
```

`hub.secrets.json` 只保存在本机（权限 0600，被 Git 忽略），包含登录密码、加密密钥和 VAPID 密钥。保留备份；不要在后续部署重新生成 KEK，否则无法解密已有 API / 推送配置。VAPID 密钥也应保持不变，否则需要重新订阅通知。Worker 地址使用部署输出的 URL；需要自定义域名时在 Cloudflare 控制台绑定。

默认前端是 `https://none0enon.github.io/ai-mobile/`。自托管前端时设置 `HUB_APP_URL` 后重跑 configure/deploy；它同时配置通知链接和 CORS。

## 接通 App

1. 「我的 → 云端与同步」（原同步入口）填 Worker 地址和生成文件里的 `HUB_PASSWORD`，连接。
2. 在 API 设置中接通主动消息（或跟随主对话），选择主动消息预设。
3. 点击「启用云端主动消息」。角色上下文更新到 D1；只把这个功能使用的主/备用 API 和 Key 通过 `/v1/secrets/proactive` 交给自己的 Worker，以 AES-GCM 加密，只写不读。
4. 「主动消息 → 通知通道」开启这台设备的通知，或配置 Bark / ntfy / 自定义 POST JSON webhook，再按「测试」。iPhone 必须从主屏幕安装的 PWA 里授权。
5. 关闭所有 App 窗口。每 5 分钟的 Cron 独立触发；系统通知点击后直达该角色的聊天或来电界面。重新打开只拉收件箱，不生成补发。

启用总开关、角色/规则开关、实际触发时的勿扰、最近 20 分钟聊天、学习/哄睡（最长 4 小时的会话状态）、规则冷却、连续两次未回复后 6 小时退避、主动消息设置里的每日 token 预算都由云端执行。生成期间设置变化会重新检查；新上下文不会被旧输出覆盖。默认不额外添加每日条数或 token 上限。

计划覆盖昨天/今天/明天，每轮幂等刷新，因此跨午夜、跨时区、夏令时、连续数日不打开 App 都不会依赖前端续期。超过 3 小时的过期计划跳过；已生成消息永久留在收件箱。调用失败在补发窗口内退避重试。每个通知都带稳定 tag；Web Push 重投会合并通知。自定义 webhook 带 `Idempotency-Key`，接收方应据此去重（网络断开时无法保证外部通知严格只投一次）。已失效的 Web Push 订阅（404/410）自动清理。

通知正文遵循完整/只显示名字/隐藏设置；各已配置通道并发投递。无可用通知通道时，消息仍在云端生成，页面显示通知错误，后续重试只投递已保存内容。

## 验证和诊断

```sh
pnpm typecheck
pnpm test            # 本地 workerd + D1、无浏览器 Cron、并发/幂等/重试/时区、Service Worker
pnpm build
pnpm --filter @app/hub exec wrangler tail --config wrangler.deploy.json
```

「云端与同步」显示真实的上次云端检测时间、上次同步和错误。「主动消息」显示云端计划、生成错误、推送错误。`/health` 不需要认证；其余 API 使用登录得到的设备令牌（D1 仅存令牌哈希）。没有公开的 Cron 手动触发 HTTP 接口。Cron 新配置在 Cloudflare 传播可能需要约 15 分钟。

开发时 `wrangler dev --test-scheduled` 提供本地测试入口 `/cdn-cgi/local/scheduled`。它是开发工具的入口，不在生产 Worker 的路由中。

## 持续部署

`.github/workflows/hub.yml` 支持手动部署，以及配置好变量后 main 更新时部署。仓库 Secrets 设置 `CLOUDFLARE_API_TOKEN`（Worker 编辑 + D1 编辑）；Variables 设置 `CLOUDFLARE_ACCOUNT_ID`、`HUB_D1_ID`，自托管前端再设置 `HUB_APP_URL`。运行时秘密已用上述 secret bulk 写入，不随源码部署覆盖。缺少仓库变量时自动部署跳过；手动部署会明确报缺少配置。

## 范围

这是主动消息所需的上下文上传和带服务器递增 seq 的收件箱，不是整个 M2 素材/记忆/多设备同步。上下文最多保留最近 200 条定稿消息；新的云端消息会合并进下一次生成上下文。删除角色会注销其云端计划。每个设备只删除自己成功上传过的角色；空设备不会清空云端。

同一角色的上下文通过 revision 防止旧请求覆盖。多设备发生修改冲突会报错；重新连接表示以这台设备作为上下文来源。尚未导入角色的设备不会跳过对应的收件箱游标，需先导入角色。

目前支持文本消息、歌曲标签、来电通知。云端生图、真实语音通话、天气/运动事件接入、完整 Android 原生壳和素材备份仍属于各自后续模块，界面不会冒充已接入。

参考：[Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)。
