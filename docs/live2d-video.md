# Live2D 视频通话

在「角色设定 → Live2D」选择 ZIP 或模型文件夹。上传成功后可以预览表情、挥手、点头、摇头，并修改每种情绪对应的表情与动作。在聊天页点击视频按钮、输入栏的「视频通话」，或现有通话的「开启视频」，即可进入。

支持包含 `.model3.json`、`.moc3`、纹理和被引用的表情、动作、物理、姿势文件的 Cubism 3/4/5 包。ZIP 可以包含顶层文件夹及 PSD、CMO3、源码等其他文件；只解压实际引用的运行文件。多个模型的包需要先分成单模型包。运行资源保存在此设备的 IndexedDB `live2d` 表，角色只保存元数据和映射；在其他设备使用时需重新上传。新模型通过解析、Core、纹理及首帧检查并保存成功后才替换原模型。

视频沿用 `useVoiceCall` 的语音识别、流式对话、语音合成、打断、输入方式和通话记录。背景取该角色当前节律时段的地点，缺少节律时取角色地点，再回退到房间；时段使用环境设置的 IANA 时区。背景仍使用现有 `SceneBackdrop` 场景插画。

嘴型使用 `playBytes.onAudioLevel`，由解码后的音频响度和实际播放进度驱动。字幕的模拟音量、麦克风输入不会驱动角色嘴型。暂停、等待音频、播放错误、取消和挂断归零，动作、表情、物理更新之后再次覆盖唇形以保证静默时闭嘴。无法解码响度时保持闭嘴。自动眨眼按模型 EyeBlink 分组，嘴型按 LipSync 分组；没有分组时尝试标准 Cubism 参数。

AI 继续使用现有 `[expr:smile]` 等情绪标签。自动映射模型实际导出的表情名称，用户可调整；当前说出的句子触发打招呼、赞同、否定动作。斑 v19 的特殊手势参数由连续控制器处理，新的姿势直接改变目标，不建立动作等待队列。其他模型使用导出的动作和配置映射。

## 验证

```sh
pnpm typecheck
pnpm build
pnpm --filter @app/web test
pnpm test
LIVE2D_TEST_ZIP=/path/to/Madara-Live2D-v19-complete-interactive.zip pnpm --filter @app/web test:e2e
```

Playwright 使用本地浏览器。需要时先执行 `pnpm --filter @app/web exec playwright install chromium`。未设置 `LIVE2D_TEST_ZIP` 时仅跳过需要实际模型的用例，音频回归仍执行。

可另外设置 `LIVE2D_TEST_FOLDER=/path/to/Hiyori` 检查普通 SDK 模型的文件夹上传、移除和 WebGL 丢失后重试。将单文件预览构建在本机启动后，设置 `LIVE2D_PREVIEW_URL=http://127.0.0.1:5176` 可同时检查构建产物中的 Core/Framework 加载顺序。所有浏览器用例可以并行运行。

实测包：`Madara-Live2D-v19-complete-interactive.zip`，选取 19 个引用文件，共 140,542,857 字节（134.0 MiB）。测试涵盖完整 ZIP 上传、刷新恢复、眨眼参数、表情与连续手势、角色节律背景变化、音频有声/静音段嘴型、TTS 失败时闭嘴、视频/语音切换及挂断。端到端通话使用本地模拟 LLM/TTS 接口和带静音段的 PCM 音频，经过应用原有请求与播放链路；不依赖用户的付费 API。手机真机和外部服务商需在配置好语音后验收。

模型不打包进仓库或站点。SDK 构建来源和重建方式见 `apps/web/src/vendor/cubism/NOTICE.md`。
