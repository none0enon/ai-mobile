# Cloudflare 主动消息与每日节律

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

## 每日节律（PWA 关闭也生成）

1. 部署新版 Worker（包括 `0002_rhythm.sql` 迁移）和前端。现有 GitHub Actions 会先应用迁移再部署 Worker。
2. 在 App 连接自己的 Worker，在 API 设置里接通「节律」，在「我的 → 节律」把角色设为「每天变化」。导入角色须先建世界。
3. 设置会自动同步；也可在「云端与同步」点「立即同步」，确认没有错误后关闭 PWA。无需开启主动消息或通知权限。

现有每 5 分钟的 Cron 包含每天 04:00。Worker 根据已同步的「我的环境」IANA 时区计算节律日，在 04:00 起生成当日内容；Cloudflare 的 Cron 表达式使用 UTC，日期判断在 Worker 内转换，支持夏令时与非整点时区。每轮都会检查当前节律日，所以临时失败、停机或首次在 4 点之后接通时可以补生成，无需打开 PWA。4 点前仍属于前一天，时区采用上次成功同步的设置。

节律上下文和 API 独立于主动消息：`/v1/rhythm/contexts/:id` 上传角色、世界、模板、变化选项、所选预设和最近聊天材料；`/v1/secrets/rhythm` 加密保存实际跟随链上的主/备用 API 和 Key，只写不读。没有聊天记录的角色也可单独生成。生成时重新构造今天的日期和最近已生成节律，并复用本机的作息检查、固定项目、三餐和穿着选项。

D1 的 `(character_id, date)` 唯一约束与单日租约处理重复/重叠 Cron；各角色同时开始，慢角色不拖住其他角色。节律 API 中已设置的每日 token 预算在 D1 中跨角色原子预留，不额外添加上限。失败在后续 Cron 重试，Worker 中断后的过期租约可再次领取。生成期间上下文改动或删除时不会提交旧结果。`/v1/rhythm/days` 返回持久化结果和可安全展示的错误；保留约一个月历史。

连接中的 PWA 只同步自动生成的结果，不会因重新打开而再排一次。手动修改、恢复模板或更新的手动生成结果优先保留在本机。把角色改为「固定」、删除角色或移除其世界并同步后停止它的云端生成。断开设备连接只停止同步，已保存的云端每日任务仍继续运行。

## 记忆整理（每天凌晨 4 点，PWA 关闭也整理）

1. 部署新版 Worker（包括 `0003_memory.sql` 迁移）和前端。现有 GitHub Actions 会先应用迁移再部署 Worker。
2. 在「API 设置」里接通「记忆整理」（和「总结 / 记忆」分开配置，默认跟随主对话）。
3. 连接「云端与同步」后自动上传：每个角色这次要整理的东西（可能重复的记忆、时间线该合并的组、过期的待跟进、画像卡和新记下的事，不传全部记忆）和「记忆整理」的 API（Key 加密保存）。内容没变不重复上传。

每 5 分钟的 Cron 按「我的环境」的时区判断凌晨 4 点，每个角色每天整理一次；手机没上传新内容时不重复整理。四件事（合并重复、合并时间线、改时态、改画像卡）各调用一次模型，某一件失败不影响别的，全部失败时稍后自动重试。`(character_id, date)` 唯一约束和租约处理重叠的 Cron；整理期间手机上传了新内容时这次结果作废，下一轮用新的重试。结果写成修改记录存进 D1（保留约两周），手机打开时拉取并应用，你在手机上改过的那一处跳过。不检查每日 token 预算。「云端与同步」里显示「云端记忆整理」是否接通和最近的错误。

没连云端时，打开 App 后距上次整理超过 20 小时的角色会在本机补一次；记忆本里也能「立即整理」。

## 验证和诊断

```sh
pnpm typecheck
pnpm build:hub       # 本地构建 Worker
pnpm build
pnpm --filter @app/hub exec wrangler tail --config wrangler.deploy.json
```

「云端与同步」显示真实的上次云端检测时间、上次同步和错误。旧 Worker 缺少接口时会提示更新，版本冲突与其他错误分别列出。「主动消息」区分本机待同步的计划和云端已确认的计划；旧设置已发送的历史消息保留实际时间。`/health` 不需要认证；其余 API 使用登录得到的设备令牌（D1 仅存令牌哈希）。没有公开的 Cron 手动触发 HTTP 接口。Cron 新配置在 Cloudflare 传播可能需要约 15 分钟。

开发时 `wrangler dev --test-scheduled` 提供本地测试入口 `/cdn-cgi/local/scheduled`。它是开发工具的入口，不在生产 Worker 的路由中。

## 持续部署

`.github/workflows/hub.yml` 支持手动部署，以及 main 更新时部署。仓库 Secrets 设置 `CLOUDFLARE_API_TOKEN`（Worker 编辑 + D1 编辑）；Variables 设置 `CLOUDFLARE_ACCOUNT_ID`、`HUB_D1_ID`，自托管前端再设置 `HUB_APP_URL`。运行时秘密已用上述 secret bulk 写入，不随源码部署覆盖。缺少上述密钥或变量时，工作流会明确失败并列出缺失名称，不再静默跳过。已有本机 Wrangler 登录也可按前述 configure → migrations apply → deploy 更新，保持原有运行时密钥。

## 范围

这里包括主动消息上下文、带服务器递增 seq 的收件箱，以及每日节律上下文与结果，不是整个 M2 素材/记忆/多设备同步。上下文最多保留最近 200 条定稿消息；新的云端消息会合并进下一次生成上下文。删除角色会注销其云端计划。每个设备只删除自己成功上传过的角色；空设备不会清空云端。

同一角色的上下文通过 revision 防止旧请求覆盖。多设备发生修改冲突会报错；「用本机设置重新同步」会读取最新 revision，再以这台设备作为上下文来源；不需要断开或重新填写密码。尚未导入角色的设备不会跳过对应的收件箱游标，需先导入角色。

目前支持文本消息、歌曲标签、来电通知。云端生图、真实语音通话、天气/运动事件接入、完整 Android 原生壳和素材备份仍属于各自后续模块，界面不会冒充已接入。

参考：[Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)。
