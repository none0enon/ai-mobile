/**
 * 从 Claude 模型名认出系列和版本，决定哪些参数能发。
 * 规则对照 SillyTavern 的 sendClaudeRequest（useThinking / isLimitedSampling / noPrefillModel / isAdaptiveModel / noSamplingModel），
 * 基础写法来自 math-reader 的 claudeModelInfo。
 *
 * 认两种命名：新的 claude-opus-4-7、claude-sonnet-4-5-20250929、anthropic/claude-sonnet-5.5、claude-fable-5-1，
 * 老的 claude-3-7-sonnet-20250219、claude-3-5-haiku。认不出时返回 null，按普通模型处理。
 * 大版本号只认一到两位数字：math-reader 原来的写法会把 claude-3-5-sonnet-20241022 的日期当成大版本号。
 */
export interface ClaudeModelInfo {
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
  major: number;
  minor: number;
  /** 支持扩展思考（thinking 参数） */
  thinking: boolean;
  /** 自适应思考：思考强度用 output_config.effort（low / medium / high / max），不用 budget_tokens */
  adaptive: boolean;
  /** 不接受 temperature / top_p / top_k */
  noSampling: boolean;
  /** temperature 和 top_p 只能二选一 */
  limitedSampling: boolean;
  /** 不接受助手预填：最后一条是 assistant 时要改成 user */
  noPrefill: boolean;
  /** 不带 thinking 参数也会思考，只是默认不返回思考内容 */
  thinksByDefault: boolean;
}

export function claudeModelInfo(model: string): ClaudeModelInfo | null {
  const name = String(model || '').toLowerCase();
  let family: ClaudeModelInfo['family'];
  let major: number;
  let minor: number;
  const modern = name.match(/(opus|sonnet|haiku|fable|mythos)[-_.]?(\d{1,2})(?!\d)(?:[-_.](\d{1,2})(?!\d))?/);
  const legacy = name.match(/claude-(\d)(?:[-_.](\d))?-(opus|sonnet|haiku)/);
  if (modern) {
    family = modern[1] as ClaudeModelInfo['family'];
    major = Number(modern[2]);
    minor = Number(modern[3] || 0);
  } else if (legacy) {
    family = legacy[3] as ClaudeModelInfo['family'];
    major = Number(legacy[1]);
    minor = Number(legacy[2] || 0);
  } else if (/claude-(fable|mythos)/.test(name)) {
    family = name.includes('mythos') ? 'mythos' : 'fable';
    major = 5;
    minor = 0;
  } else {
    return null;
  }
  const atLeast = (a: number, b: number) => major > a || (major === a && minor >= b);
  const latest = family === 'fable' || family === 'mythos' || major >= 5;
  const noSampling = latest || (family === 'opus' && atLeast(4, 7));
  return {
    family,
    major,
    minor,
    thinking: latest || (family === 'sonnet' && atLeast(3, 7)) || (family === 'opus' && major >= 4) || (family === 'haiku' && atLeast(4, 5)),
    adaptive: noSampling,
    noSampling,
    limitedSampling: !noSampling && ((family === 'opus' && atLeast(4, 1)) || (family === 'sonnet' && atLeast(4, 5)) || (family === 'haiku' && atLeast(4, 5))),
    noPrefill: latest || ((family === 'opus' || family === 'sonnet') && atLeast(4, 6)),
    thinksByDefault: latest,
  };
}
