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
