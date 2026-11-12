/**
 * @app/ai：AI 调用层。只用 fetch / ReadableStream / DecompressionStream 等 Web 标准接口，
 * 浏览器（PWA、安卓 WebView）、Cloudflare Worker、Node 都能直接用。
 *
 *   core/       端点、请求、错误、小工具
 *   llm/        文本对话：OpenAI 兼容 / Claude / Gemini（移植自 math-reader 的 callAI / readAIStream，参数规则对照 SillyTavern）
 *   tts/        语音合成：OpenAI 兼容（硅基流动 CosyVoice）/ MiniMax / 火山引擎豆包 / Fish Audio / GPT-SoVITS
 *   image/      生图：NovelAI（V4 / V4.5 / V3）/ OpenAI 兼容（参考 SleepTogether 的 image-manager）
 *   embedding/  向量化：OpenAI 兼容 / Gemini / Workers AI，float16 编码、向量空间
 *   channels.ts 渠道表：每个功能能选哪些渠道、默认地址和常用模型
 *   agents/     多智能体：按功能路由与备用 API、每日上限、各智能体的提示词与解析、配图流水线、记忆检索
 */

export * from './core/errors.ts';
export * from './core/http.ts';
export * from './core/endpoint.ts';
export { hashString, parseJsonLoose, randomSeed } from './core/util.ts';

export * from './llm/types.ts';
export { chatOnce, canChat } from './llm/client.ts';
export { readAIStream } from './llm/stream.ts';
export { fromOpenAIBody, normalizeTurns, postProcessMessages, START_PLACEHOLDER, toClaude, toGemini } from './llm/messages.ts';
export { claudeModelInfo, type ClaudeModelInfo } from './llm/claude.ts';
export { claudeThinking, deepseekThinking, geminiThinking, openaiReasoningEffort, thinkingAlias } from './llm/reasoning.ts';
export { isVertexOpenModel, parseServiceAccount, vertexOpenModelId, type ServiceAccount } from './llm/vertex.ts';
export { applyFilters, compileFilter, compileFilters, DEFAULT_OUTPUT_FILTERS } from './llm/filter.ts';
export { outputTokenCaps } from './llm/retry.ts';

export * from './tts/types.ts';
export { synthesize, canSpeak, ttsCacheKey, ttsInput } from './tts/client.ts';
export { DEFAULT_TTS_TEXT, prepareTtsText, splitSentences, guessLanguage } from './tts/text.ts';
export { CLONE_STATUS, isClonedVoice, volcengineClone, volcengineCloneStatus, volcResourceId } from './tts/volcengine.ts';
export { DEFAULT_EMOTION_MAP, resolveEmotion } from './tts/emotion.ts';
export { sniffAudioMime } from './tts/providers.ts';

export { transcribeAudio, canTranscribe, type SttRequest } from './stt/client.ts';

export * from './image/types.ts';
export { generateImage, canDraw } from './image/client.ts';
export { buildNovelaiPayload, novelaiSubscription, varietySigma, type NovelaiSubscription } from './image/novelai.ts';
export { IMAGE_SIZES, NOVELAI_MODELS, freeForOpus, joinTags, resolveSize } from './image/presets.ts';
export { applyImageStyle, composePrompt, DEFAULT_IMAGE_STYLE } from './image/style.ts';
export { extractImage, sniffImageMime } from './image/extract.ts';
export { listZip, readZipEntry, unzipFirst, type ZipEntry } from './image/zip.ts';

export { embedTexts, canEmbed, instructionPrefix, type EmbedPurpose, type EmbedRequest, type EmbedResult } from './embedding/client.ts';
export * from './embedding/vector.ts';

export { listModels, testConnection, STATIC_MODELS, type TestResult } from './connection.ts';
export * from './channels.ts';

export * from './agents/router.ts';
export * from './agents/usage.ts';
export * from './agents/system.ts';
export * from './agents/taskPreset.ts';
export * from './agents/imagePrompt.ts';
export * from './agents/sidestory.ts';
export * from './agents/summary.ts';
export * from './agents/retrieval.ts';
export * from './agents/illustrate.ts';
