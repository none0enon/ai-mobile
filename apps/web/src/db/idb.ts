import { watch, type WatchSource } from 'vue';

/**
 * 本机数据库（IndexedDB）。导入的角色卡、世界书、预设，以及和导入角色的聊天都存在这里，刷新、离线后还在。
 * 演示角色和聊天在首次打开时初始化，之后也持久化，避免丢失真实云端消息。
 * 先用一个很薄的封装；做同步（发件箱、seq）时再换成设计文档里的 Dexie 表结构。
 */

const DB_NAME = 'ai-mobile';
const VERSION = 3;
/**
 * - settings：API 设置（按功能）、回复修剪等设置（以后随同步走）
 * - secrets：API Key，只存这台设备，永远不进同步数据
 * - assets：生成的图片、语音（按内容哈希存；以后同步时传到 R2）
 */
const STORES = ['characters', 'lorebooks', 'presets', 'chats', 'messages', 'settings', 'secrets', 'assets', 'books'] as const;
export type StoreName = (typeof STORES)[number];

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      // 无痕模式、存储被禁用：退回只在内存里
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function getOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** 读出整张表：键和值一起（getAll 只给值） */
export async function getEntries<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
  const db = await open();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const os = db.transaction(store, 'readonly').objectStore(store);
      const keysReq = os.getAllKeys();
      const valuesReq = os.getAll();
      valuesReq.onsuccess = () => {
        const keys = (keysReq.result ?? []) as IDBValidKey[];
        resolve((valuesReq.result as T[]).map((value, i) => ({ key: String(keys[i]), value })));
      };
      valuesReq.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function write(store: StoreName, puts: { key: string; value: unknown }[], dels: string[] = []): Promise<boolean> {
  if (!puts.length && !dels.length) return true;
  const db = await open();
  if (!db) return false;
  try {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const p of puts) os.put(p.value, p.key);
    for (const k of dels) os.delete(k);
    await done(tx);
    return true;
  } catch {
    return false;
  }
}

const flushers = new Set<() => Promise<void>>();
let listening = false;

/**
 * 自动保存：source 变了就（防抖后）把有变化的记录写进 store，消失的记录删掉。
 * 值按 JSON 存（去掉 Vue 的响应式代理），所以只放能 JSON 化的数据。
 */
export function autoSave(store: StoreName, source: () => { key: string; value: unknown }[], watchSource: WatchSource, wait = 400) {
  const last = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = true;

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    const puts: { key: string; value: unknown }[] = [];
    const seen = new Set<string>();
    for (const { key, value } of source()) {
      seen.add(key);
      const json = JSON.stringify(value);
      if (last.get(key) === json) continue;
      last.set(key, json);
      puts.push({ key, value: JSON.parse(json) });
    }
    const dels = [...last.keys()].filter((k) => !seen.has(k));
    for (const k of dels) last.delete(k);
    await write(store, puts, dels);
  }

  watch(
    watchSource,
    () => {
      if (paused) return;
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), wait);
    },
    { deep: true },
  );
  flushers.add(flush);
  if (!listening && typeof document !== 'undefined') {
    listening = true;
    // 切到后台 / 关掉页面前把没写完的写掉
    const all = () => flushers.forEach((f) => void f());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && all());
    window.addEventListener('pagehide', all);
  }

  return {
    /** 读完库以后调用：记下现在的内容（不用再写回去），之后开始自动保存 */
    start() {
      for (const { key, value } of source()) last.set(key, JSON.stringify(value));
      paused = false;
    },
    flush,
  };
}
