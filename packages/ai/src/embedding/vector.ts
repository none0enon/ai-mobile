import { base64Decode, base64Encode } from '@app/shared';

/**
 * 向量的小工具。记忆的向量存成 { model, dims, data: float16 小端序 base64 }（设计文档 §6.2）：
 * 1024 维约 2 KB，随同步下发；检索在手机上暴力算余弦。
 */

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i += 1) s += (a[i] as number) * (b[i] as number);
  return s;
}

export function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

/** 单位化（长度为 0 的向量原样返回） */
export function l2normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  const n = norm(out);
  if (n > 0) for (let i = 0; i < out.length; i += 1) out[i] = (out[i] as number) / n;
  return out;
}

/** 余弦相似度。向量都已单位化时就是点积；这里仍除以长度，对没单位化的向量也对 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  const d = norm(a) * norm(b);
  return d > 0 ? dot(a, b) / d : 0;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float32 → IEEE 754 半精度（就近舍入到偶数；含次正规数、无穷、NaN） */
export function toHalf(x: number): number {
  f32[0] = x;
  const bits = u32[0] as number;
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  let mant = bits & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && half & 1)) half += 1;
    return sign | half;
  }
  let half = sign | (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  // 进位可能进到指数位：正好是向上舍入到下一个数量级（或无穷）
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half += 1;
  return half;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** 向量 → float16 小端序 base64 */
export function encodeVector(v: ArrayLike<number>): string {
  const bytes = new Uint8Array(v.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < v.length; i += 1) view.setUint16(i * 2, toHalf(v[i] as number), true);
  return base64Encode(bytes);
}

export function decodeVector(data: string): Float32Array {
  const bytes = base64Decode(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = fromHalf(view.getUint16(i * 2, true));
  return out;
}

/** OpenAI 兼容接口按 encoding_format: 'base64' 回的是 float32 小端序 */
export function decodeFloat32Base64(data: string): Float32Array {
  const bytes = base64Decode(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/**
 * 模型族：同一个模型在不同服务商那里名字不同（硅基流动 BAAI/bge-m3、Workers AI @cf/baai/bge-m3），向量可以互相比较。
 * 取最后一段、转小写，去掉 @cf/、models/、:latest。
 */
export function modelFamily(model: string): string {
  const m = model.trim().toLowerCase().replace(/^@cf\//, '').replace(/^models\//, '').replace(/:latest$/, '');
  return m.split('/').pop() ?? m;
}

/**
 * 向量空间 = 模型族 + 维度。只有同一个空间里的向量能比较：换了模型，或同一个模型换了维度（Qwen3-Embedding 可截短），
 * 旧向量都要重算
 */
export function vectorSpace(model: string, dims: number): string {
  return `${modelFamily(model)}@${dims}`;
}

export function sameSpace(a: { model: string; dims: number }, b: { model: string; dims: number }): boolean {
  return a.dims === b.dims && modelFamily(a.model) === modelFamily(b.model);
}
