import { getOne, write } from '@/db/idb';
import { uid } from '@/utils/id';

/**
 * 本机素材库：生成的配图、语音按内容哈希存在 IndexedDB 的 assets 表，消息里只记 key
 * （设计文档 §3.3：以后同步时按同一个哈希传到 R2，同一个文件只传一次）。
 */

interface StoredAsset {
  mime: string;
  data: ArrayBuffer;
  createdAt: number;
}

const urls = new Map<string, string>();

/** SHA-256 内容哈希；不是安全上下文（局域网 http 调试）时没有 crypto.subtle，退回随机 id */
async function contentKey(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  try {
    if (crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // 退回随机 id
  }
  return uid('asset');
}

export async function putAsset(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<string> {
  const key = await contentKey(bytes);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await write('assets', [{ key, value: { mime, data, createdAt: Date.now() } satisfies StoredAsset }]);
  // 本机数据库不可用（无痕模式）时也能马上显示
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(new Blob([bytes], { type: mime })));
  return key;
}

export async function assetUrl(key: string): Promise<string | null> {
  const cached = urls.get(key);
  if (cached) return cached;
  const a = await getOne<StoredAsset>('assets', key);
  if (!a) return null;
  const url = URL.createObjectURL(new Blob([a.data], { type: a.mime }));
  urls.set(key, url);
  return url;
}

/** 删掉一份素材（调用的地方确认没有别处再用它） */
export async function dropAsset(key: string): Promise<void> {
  const url = urls.get(key);
  if (url) URL.revokeObjectURL(url);
  urls.delete(key);
  await write('assets', [], [key]);
}
