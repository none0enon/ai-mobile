/**
 * 不依赖 DOM / Node 的字节工具：UTF-8、Base64、CRC32。
 * 这个包要能原样跑在 Cloudflare Worker 里，所以不用 Buffer、atob、TextDecoder 的类型。
 */

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      c = Math.min(c, 0x10ffff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return Uint8Array.from(out);
}

/** 解码 UTF-8；坏字节换成 U+FFFD，不抛错 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const n = bytes.length;
  const cont = (k: number) => k < n && ((bytes[k] as number) & 0xc0) === 0x80;
  while (i < n) {
    const b = bytes[i] as number;
    let cp = 0xfffd;
    let len = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0 && cont(i + 1)) {
      cp = ((b & 31) << 6) | ((bytes[i + 1] as number) & 63);
      len = 2;
    } else if (b >= 0xe0 && b < 0xf0 && cont(i + 1) && cont(i + 2)) {
      cp = ((b & 15) << 12) | (((bytes[i + 1] as number) & 63) << 6) | ((bytes[i + 2] as number) & 63);
      len = 3;
    } else if (b >= 0xf0 && b < 0xf5 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      cp = ((b & 7) << 18) | (((bytes[i + 1] as number) & 63) << 12) | (((bytes[i + 2] as number) & 63) << 6) | ((bytes[i + 3] as number) & 63);
      len = 4;
    }
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));
B64_INDEX.set('-', 62);
B64_INDEX.set('_', 63);

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

/** 解 Base64（也认 URL 安全写法）；忽略空白和非法字符 */
export function base64Decode(text: string): Uint8Array {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of text) {
    const v = B64_INDEX.get(ch);
    if (v === undefined) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

let CRC_TABLE: Uint32Array | null = null;

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Latin-1（PNG tEXt 的关键字和 Base64 文本都是 ASCII） */
export function latin1Decode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

export function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
