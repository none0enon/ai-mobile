/**
 * 文本文件的字节 → 文字（字幕、TXT 小说）：带 BOM 的按 BOM；先按 UTF-8 读，读不通再按 GB18030（兼容 GBK）读，
 * 国内的字幕和小说很多是 GBK
 */
export function decodeTextFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

export async function readTextFile(file: Blob): Promise<string> {
  return decodeTextFile(new Uint8Array(await file.arrayBuffer()));
}

/**
 * "丰收碗（Harvest Bowl）" → { zh: '丰收碗', en: 'Harvest Bowl' }：英文的店里的菜名、商品名写成"中文（英文原名）"，
 * 界面上英文淡一点显示，搜索时用英文。括号在最后、里面是英文（有三个字母以上的词、没有汉字）才拆，
 * "鸡胸肉（1.5 lb）""酸奶（约 200 g）"这种不拆
 */
export function splitEnglish(text: string): { zh: string; en: string } {
  const t = text.trim();
  const m = /^(.+?)\s*[（(]([^（）()]+)[）)]$/.exec(t);
  const inner = m?.[2]?.trim() ?? '';
  if (!m || !/[A-Za-z]{3,}/.test(inner) || /[㐀-鿿]/.test(inner)) return { zh: t, en: '' };
  return { zh: m[1]!.trim(), en: inner };
}
