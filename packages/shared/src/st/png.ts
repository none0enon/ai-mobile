import { crc32, latin1Decode, latin1Encode, utf8Decode } from './bytes.ts';

/**
 * PNG 角色卡：角色数据放在 tEXt 块里，关键字 chara（V2）或 ccv3（V3），内容是 Base64 的 UTF-8 JSON。
 * 读取时优先 ccv3，其次 chara（同 SillyTavern）；导出时两种都写。
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => bytes[i] === b);
}

interface Chunk {
  type: string;
  /** 整个块（长度 + 类型 + 数据 + CRC）在文件里的位置 */
  start: number;
  end: number;
  data: Uint8Array;
}

function readChunks(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes)) throw new Error('不是 PNG 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const len = view.getUint32(i);
    const type = latin1Decode(bytes.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > bytes.length) throw new Error('PNG 文件不完整');
    chunks.push({ type, start: i, end, data: bytes.subarray(i + 8, i + 8 + len) });
    i = end;
    if (type === 'IEND') break;
  }
  return chunks;
}

/**
 * 读出 PNG 里所有文本块：tEXt，以及未压缩的 iTXt。关键字统一转小写。
 * （zTXt / 压缩的 iTXt 需要 inflate，ST 也不写这两种，遇到时跳过）
 */
export function readPngText(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of readChunks(bytes)) {
    if (c.type === 'tEXt') {
      const zero = c.data.indexOf(0);
      if (zero < 0) continue;
      const key = latin1Decode(c.data.subarray(0, zero)).toLowerCase();
      if (!(key in out)) out[key] = latin1Decode(c.data.subarray(zero + 1));
    } else if (c.type === 'iTXt') {
      const zero = c.data.indexOf(0);
      if (zero < 0 || c.data[zero + 1] !== 0) continue; // 压缩的跳过
      const key = latin1Decode(c.data.subarray(0, zero)).toLowerCase();
      // 关键字\0 压缩标志 压缩方法 语言标签\0 翻译关键字\0 正文
      let p = zero + 3;
      p = c.data.indexOf(0, p) + 1;
      p = c.data.indexOf(0, p) + 1;
      if (p <= 0) continue;
      if (!(key in out)) out[key] = utf8Decode(c.data.subarray(p));
    }
  }
  return out;
}

function makeTextChunk(keyword: string, text: string): Uint8Array {
  const data = latin1Encode(`${keyword}\0${text}`);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(latin1Encode('tEXt'), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * 写入（或替换）文本块。同名的旧 tEXt / iTXt 块会被去掉，新块放在 IEND 前面。
 * text 必须是 Latin-1（角色卡用 Base64，满足这个要求）。
 */
export function writePngText(bytes: Uint8Array, entries: Record<string, string>): Uint8Array {
  const keys = new Set(Object.keys(entries).map((k) => k.toLowerCase()));
  const chunks = readChunks(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  for (const c of chunks) {
    if (c.type === 'IEND') {
      for (const [k, v] of Object.entries(entries)) parts.push(makeTextChunk(k, v));
    }
    if (c.type === 'tEXt' || c.type === 'iTXt') {
      const zero = c.data.indexOf(0);
      if (zero >= 0 && keys.has(latin1Decode(c.data.subarray(0, zero)).toLowerCase())) continue;
    }
    parts.push(bytes.subarray(c.start, c.end));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
