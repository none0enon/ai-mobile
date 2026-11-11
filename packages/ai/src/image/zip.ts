import { crc32 } from '@app/shared';
import type { Bytes } from '../core/http.ts';

/**
 * 最小的 ZIP 读取：NovelAI 生图接口返回一个 zip（里面是 image_0.png）。
 * 只认"不压缩"和 deflate 两种方式，deflate 用 Web 标准的 DecompressionStream('deflate-raw') 解，
 * 浏览器、Cloudflare Worker、Node 都有，不用引第三方库。不支持 ZIP64（NovelAI 的包很小）。
 */
export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** 本地文件头的位置 */
  offset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function listZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 目录结尾记录在文件末尾，后面最多跟 65535 字节的注释
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 zip 文件（找不到目录）');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== CENTRAL) throw new Error('zip 目录损坏');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    entries.push({
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Bytes> {
  const stream = new Response(new Uint8Array(data)).body;
  if (!stream) throw new Error('当前环境不支持流');
  const out = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Bytes> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== LOCAL) throw new Error('zip 文件头损坏');
  const nameLen = view.getUint16(entry.offset + 26, true);
  const extraLen = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  let data: Bytes;
  if (entry.method === 0) data = new Uint8Array(raw);
  else if (entry.method === 8) data = await inflateRaw(raw);
  else throw new Error(`不支持的 zip 压缩方式 ${entry.method}`);
  if (data.length !== entry.size || crc32(data) >>> 0 !== entry.crc >>> 0) throw new Error(`zip 里的 ${entry.name} 校验失败`);
  return data;
}

/** 解出第一个满足条件的文件（默认第一个 .png） */
export async function unzipFirst(bytes: Uint8Array, match: (name: string) => boolean = (n) => /\.png$/i.test(n)): Promise<{ name: string; data: Bytes } | null> {
  const entry = listZip(bytes).find((e) => match(e.name));
  if (!entry) return null;
  return { name: entry.name, data: await readZipEntry(bytes, entry) };
}
