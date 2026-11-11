/**
 * 输出修剪（移植自 SleepTogether 的 GlobalFilterManager）：所有文本智能体的回复统一过一遍正则，
 * 去掉漏出来的思考内容。没命中任何规则时原样返回，不动原来的格式。
 *
 * 规则写法：
 * - /pattern/flags 字面量（自动补 g，可以带 i 等）；
 * - <tag></tag> 简写：去掉整段这个标签；
 * - 其余当原始正则。
 */
export const DEFAULT_OUTPUT_FILTERS: string[] = [
  // <!-- consider: … --> 注释式思考
  '/<!--\\s*consider:[\\s\\S]*?-->/g',
  // 只有结束标签：开头到第一个 </think> 之间的内容（中转吞了开标签）
  '/^[\\s\\S]*?<\\/think>/i',
  // 完整的 <think>…</think>（不分大小写）
  '/<think>[\\s\\S]*?<\\/think>/gi',
];

export function compileFilter(pattern: string): RegExp | null {
  const p = pattern.trim();
  if (!p) return null;
  try {
    const literal = p.match(/^\/([\s\S]+)\/([a-z]*)$/i);
    if (literal) {
      const flags = (literal[2] ?? '').includes('g') ? (literal[2] ?? '') : `${literal[2] ?? ''}g`;
      return new RegExp(literal[1] ?? '', flags);
    }
    const tag = p.match(/^<(\w+)>.*<\/\1>$/);
    if (tag) return new RegExp(`<${tag[1]}>[\\s\\S]*?<\\/${tag[1]}>`, 'g');
    return new RegExp(p, 'g');
  } catch {
    return null;
  }
}

export function compileFilters(patterns: readonly string[]): RegExp[] {
  return patterns.map(compileFilter).filter((r): r is RegExp => r !== null);
}

export function applyFilters(text: string, filters: readonly RegExp[]): string {
  if (!filters.length || !text) return text;
  let out = text;
  for (const re of filters) {
    re.lastIndex = 0;
    out = out.replace(re, '');
  }
  if (out === text) return text;
  // 修剪后可能留下大段空行
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
