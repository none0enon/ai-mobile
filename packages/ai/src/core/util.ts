/**
 * 小工具：缓存用的字符串哈希、十六进制解码、宽松的 JSON 解析、随机种子。
 */

/**
 * 53 位字符串哈希（cyrb53），返回 14 位十六进制。只用作缓存的键（TTS 音频、查询向量），
 * 不需要密码学强度；也不用 crypto.subtle——它在 http 的局域网调试地址下不可用。
 */
export function hashString(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error('不是合法的十六进制');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * 从模型输出里取出 JSON：容忍 ```json 代码块、前后的解释文字、思考标签。
 * 先整体解析；不行再取第一个配平的 { … } 或 [ … ]。都不行返回 undefined。
 */
export function parseJsonLoose(text: string): unknown {
  const raw = text
    .replace(/^\uFEFF/, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  const candidates = fenced?.[1] ? [fenced[1].trim(), raw] : [raw];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // 继续找配平的括号
    }
    const block = firstBalanced(c);
    if (block) {
      try {
        return JSON.parse(block);
      } catch {
        // 末尾多了逗号之类的：去掉对象 / 数组结尾前的逗号再试一次
        try {
          return JSON.parse(block.replace(/,\s*([}\]])/g, '$1'));
        } catch {
          // 放弃这一段
        }
      }
    }
  }
  return undefined;
}

/** 第一个括号配平的 JSON 对象或数组（跳过字符串里的括号） */
function firstBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth += 1;
    } else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** NovelAI 等接口接受的种子范围：0 … 2^32 − 1 */
export function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] ?? Math.floor(Math.random() * 4294967295);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
