/**
 * 从 Claude 模型名认出系列和版本（claude-opus-4-7、claude-sonnet-5-5、anthropic/claude-opus-4.6 等），
 * 移植自 math-reader 的 claudeModelInfo。
 * - noSampling：不接受 temperature（Opus 4.7 及以后、Sonnet / Haiku 5 及以后、Fable / Mythos）；
 * - thinksByDefault：不带 thinking 参数也会思考（Opus / Sonnet / Haiku 5 及以后、Fable / Mythos），只是默认不返回思考内容。
 * 认不出（如 claude-3-7-sonnet-20250219）时返回 null。
 *
 * 和 math-reader 的一处不同：大版本号限定一到两位数字。原来的写法会把 claude-3-5-sonnet-20241022 里的
 * 日期 20241022 当成大版本号，误判成"不接受 temperature"。
 */
export function claudeModelInfo(model: string): { noSampling: boolean; thinksByDefault: boolean } | null {
  const m = String(model || '')
    .toLowerCase()
    .match(/(opus|sonnet|haiku|fable|mythos)[-_.]?(\d{1,2})(?!\d)(?:[-_.](\d{1,2})(?!\d))?/);
  if (!m) return null;
  const family = m[1];
  const major = Number(m[2]);
  const minor = Number(m[3] || 0);
  const latest = family === 'fable' || family === 'mythos' || major >= 5;
  return {
    noSampling: latest || (family === 'opus' && major === 4 && minor >= 7),
    thinksByDefault: latest,
  };
}
