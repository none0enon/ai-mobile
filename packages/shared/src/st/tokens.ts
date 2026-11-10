/**
 * 粗略估算 token：中日韩文字约 1 个/字，其他约 3.5 字符 1 个。
 * 只用来排预算和在"查看提示词"里显示占比；真实计费以服务商为准。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}
