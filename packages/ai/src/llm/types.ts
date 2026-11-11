import type { PromptProcessing, ReasoningEffort } from '@app/shared';

/**
 * 文本对话的统一请求 / 结果。各家协议（OpenAI 兼容、Claude、Gemini）在各自的文件里转换。
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export type ContentPart =
  | { type: 'text'; text: string }
  /** base64 图片（视觉智能体看饭照、运动截图） */
  | { type: 'image'; mime: string; data: string };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  /** 示例对话的 example_user / example_assistant，或预设要求写进 name 字段的名字 */
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  stop?: string[];
  /** 要求输出 JSON（OpenAI 的 response_format、Gemini 的 responseMimeType；Claude 只靠提示词）。接口不认时自动去掉 */
  json?: boolean;
  /**
   * Claude / Gemini 不支持 name 字段：转换时把名字写进正文（"名字: 内容"），
   * 示例对话的 example_user / example_assistant 换成这里的真名（同 SillyTavern）
   */
  names?: { user?: string; char?: string };
  /** 只对 OpenAI 兼容接口：原样并入请求体（预设里的其他参数、中转专有参数） */
  extraBody?: Record<string, unknown>;
  /**
   * 推理强度（同 SillyTavern）：OpenAI 兼容发 reasoning_effort，Claude 换成思考预算或自适应思考的 effort，
   * Gemini 换成 thinkingBudget / thinkingLevel。auto 或不写时交给模型
   */
  reasoningEffort?: ReasoningEffort;
  /** 要不要模型返回思考内容；默认流式时要（只决定返回不返回，不改变思考多少） */
  includeReasoning?: boolean;
  /** 助手预填（预设的 assistant_prefill）：回复从这段文字接着写。Claude 原生支持，DeepSeek 官方走前缀续写 */
  prefill?: string;
  /** 覆盖连接里的消息整理方式（OpenAI 兼容） */
  processing?: PromptProcessing;
  /**
   * 最简请求（参考 SleepTogether 的副 API）：只发模型、消息、temperature、输出上限，不带思考、惩罚、种子等参数。
   * 换到备用连接时用，换取最大的兼容性
   */
  minimal?: boolean;
}

/**
 * 流式请求的进展（同 math-reader 的 onStreamState），界面据此说明为什么还没有正文：
 * sent 请求已发出；connected 收到响应开始读流；thinking 模型在思考；streaming 正文开始输出；
 * fallback 流式失败、改用普通请求（detail 是原因）；unstreamed 服务端没有流式返回；buffered 正文到最后才一次收到
 */
export type StreamState = 'sent' | 'connected' | 'thinking' | 'streaming' | 'fallback' | 'unstreamed' | 'buffered';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatCallbacks {
  /** 每次收到新的正文或思考内容：text 是正文全文，thinking 是思考内容全文（没有时为空串） */
  onDelta?(text: string, thinking: string): void;
  onState?(state: StreamState, detail?: string): void;
}

export interface ChatOptions extends ChatCallbacks {
  signal?: AbortSignal;
  /** 默认有 onDelta 就流式 */
  stream?: boolean;
}

export interface ChatResult {
  text: string;
  thinking: string;
  usage: Usage | null;
  finishReason: string | null;
  /** 这次结果是不是边生成边收到的 */
  streamed: boolean;
}
