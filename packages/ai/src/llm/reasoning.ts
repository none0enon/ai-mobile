import type { ReasoningEffort } from '@app/shared';
import type { ClaudeModelInfo } from './claude.ts';

/**
 * 推理强度 → 各家的参数（对照 SillyTavern 的 calculateClaudeBudgetTokens / calculateGoogleBudgetTokens
 * 和 OPENAI_REASONING_EFFORT_MAP）。auto 或不写时交给模型，不发任何参数。
 */

/** OpenAI 兼容的 reasoning_effort：none 原样发（不认的接口自动去掉）；min → minimal；max 多数接口不认，按 high 发 */
export function openaiReasoningEffort(effort: ReasoningEffort | undefined): string | undefined {
  if (!effort || effort === 'auto') return undefined;
  if (effort === 'min') return 'minimal';
  if (effort === 'max') return 'high';
  return effort;
}

export interface ClaudeThinking {
  /** 请求体里的 thinking */
  thinking?: Record<string, unknown>;
  /** 自适应思考的强度：output_config.effort */
  effort?: string;
  /** 传统思考的预算（此时不能带 temperature / top_p / top_k） */
  budget?: number;
}

/**
 * Claude 的思考参数：
 * - 自适应思考的模型（Opus 4.7 起、Claude 5、Fable）：强度写进 output_config.effort；auto 时只在要思考内容时请求摘要；
 * - 传统思考的模型（3.7 Sonnet、Opus / Sonnet 4.x、Haiku 4.5）：预算按输出上限的比例算，至少 1024，非流式最多 21333。
 */
export function claudeThinking(info: ClaudeModelInfo | null, maxTokens: number, effort: ReasoningEffort | undefined, stream: boolean, includeReasoning: boolean): ClaudeThinking {
  if (!info?.thinking) return {};
  if (info.adaptive) {
    // 自适应思考关不掉：none 按最低强度
    const level = !effort || effort === 'auto' ? null : effort === 'min' || effort === 'none' ? 'low' : effort;
    if (level) return { thinking: { type: 'adaptive', ...(info.noSampling && includeReasoning ? { display: 'summarized' } : {}) }, effort: level };
    // 默认就会思考的模型：默认不返回思考内容（display: omitted），要看思考时请求摘要；只决定返回不返回，不改变思考多少
    if (info.thinksByDefault && includeReasoning) return { thinking: { type: 'adaptive', display: 'summarized' } };
    return {};
  }
  if (!effort || effort === 'auto' || effort === 'none') return {};
  const ratio: Record<Exclude<ReasoningEffort, 'auto' | 'none'>, number> = { min: 0, low: 0.1, medium: 0.25, high: 0.5, max: 0.95 };
  let budget = Math.max(1024, Math.floor(maxTokens * ratio[effort]));
  if (!stream) budget = Math.min(budget, 21333);
  return { thinking: { type: 'enabled', budget_tokens: budget }, budget };
}

/** 能设思考参数的 Gemini 模型（同 SillyTavern 的 isThinkingConfigModel） */
/** Gemini 的版本号：gemini-2.5-flash → 2.5，gemini-3.1-pro → 3.1，gemini-4-pro → 4；认不出时 0 */
function geminiVersion(m: string): number {
  const v = m.match(/^gemini-(\d+(?:\.\d+)?)/);
  return v ? Number(v[1]) : 0;
}

export function geminiHasThinkingConfig(model: string): boolean {
  const m = model.replace(/^models\//, '');
  return geminiVersion(m) >= 2.5 && /-(flash|pro)/.test(m) && !/-image|-tts|-live|embedding/.test(m);
}

/**
 * Gemini 的思考参数：2.5 系列用 thinkingBudget（auto 为 -1 动态），Gemini 3 用 thinkingLevel（auto 不发）。
 * maxTokens 没写时按 8192 算比例
 */
export function geminiThinking(model: string, maxTokens: number | undefined, effort: ReasoningEffort | undefined): { thinkingBudget?: number; thinkingLevel?: string } {
  if (!effort) return {};
  const m = model.replace(/^models\//, '');
  const max = maxTokens ?? 8192;
  const part = (r: number) => Math.floor(max * r);
  const version = geminiVersion(m);
  // Gemini 4 起只认 thinkingLevel（LOW / MEDIUM / HIGH）：设 thinkingBudget 会 400，也没有 MINIMAL（Vertex 官方文档）
  if (version >= 4) {
    const level = { auto: null, none: 'low', min: 'low', low: 'low', medium: 'medium', high: 'high', max: 'high' }[effort];
    return level ? { thinkingLevel: level } : {};
  }
  if (version >= 3 && /-pro/.test(m)) {
    const level = { auto: null, none: 'low', min: 'low', low: 'low', medium: 'low', high: 'high', max: 'high' }[effort];
    return level ? { thinkingLevel: level } : {};
  }
  if (version >= 3 && /-flash/.test(m)) {
    const minimal = /gemini-3\.7-flash/.test(m) ? 'low' : 'minimal';
    const level = { auto: null, none: minimal, min: minimal, low: 'low', medium: 'medium', high: 'high', max: 'high' }[effort];
    return level ? { thinkingLevel: level } : {};
  }
  if (effort === 'auto') return { thinkingBudget: -1 };
  const lite = /flash-lite/.test(m);
  const flash = /flash/.test(m);
  // 2.5 Flash 能关掉思考（预算 0），2.5 Pro 最少 128
  if (effort === 'min' || effort === 'none') return { thinkingBudget: lite || flash ? 0 : 128 };
  const raw = { low: part(0.1), medium: part(0.25), high: part(0.5), max: max }[effort];
  if (lite) return { thinkingBudget: Math.max(512, Math.min(raw, 24576)) };
  if (flash) return { thinkingBudget: Math.min(raw, 24576) };
  return { thinkingBudget: Math.max(128, Math.min(raw, 32768)) };
}

/**
 * 中转站用模型名后缀开思考（参考 SleepTogether：…-thinking-low / -thinking-high，以及 reasoner、reasoning）：
 * 这时 temperature 只能是 1、不能带 top_p 和惩罚项，输出上限要比思考预算大，否则转到 Claude 时会被拒绝。
 * 名字里写明 -thinking-none / no-thinking 的不算
 */
export function thinkingAlias(model: string): { budget: number } | null {
  const m = String(model || '');
  if (/(?:thinking|reasoning|effort)[-_]?none|no[-_]?thinking/i.test(m)) return null;
  if (!/thinking|reasoner|reasoning/i.test(m)) return null;
  const lower = m.toLowerCase();
  if (/high|max|xhigh/.test(lower)) return { budget: 24000 };
  if (/low|min/.test(lower)) return { budget: 2048 };
  return { budget: 10000 };
}

/**
 * DeepSeek 官方的思考参数（官网 Thinking Mode）：思考模式默认开、强度 high；
 * thinking.type 切换模式，reasoning_effort 只认 low / high / max（minimal 算 low，medium / xhigh 算 high）。
 * legacy：停用的旧模型名 deepseek-chat（非思考）/ deepseek-reasoner（思考）在推理强度为自动时保持原来的模式。
 */
export function deepseekThinking(
  effort: ReasoningEffort | undefined,
  legacy?: 'chat' | 'reasoner',
): { thinking?: { type: 'enabled' | 'disabled' }; effort?: 'low' | 'high' | 'max' } {
  if (effort === 'none') return { thinking: { type: 'disabled' } };
  if (!effort || effort === 'auto') {
    if (legacy === 'chat') return { thinking: { type: 'disabled' } };
    if (legacy === 'reasoner') return { thinking: { type: 'enabled' } };
    return {};
  }
  const map = { min: 'low', low: 'low', medium: 'high', high: 'high', max: 'max' } as const;
  return { thinking: { type: 'enabled' }, effort: map[effort] };
}
