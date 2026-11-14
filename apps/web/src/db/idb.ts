import { reactive, watch, type WatchSource } from 'vue';

/**
 * 本机数据库（IndexedDB）。导入的角色卡、世界书、预设，以及和导入角色的聊天都存在这里，刷新、离线后还在。
 * 演示角色和聊天在首次打开时初始化，之后也持久化，避免丢失真实云端消息。
 * 先用一个很薄的封装；做同步（发件箱、seq）时再换成设计文档里的 Dexie 表结构。
 */

const DB_NAME = 'ai-mobile';
const VERSION = 7;
/**
 * - settings：API 设置（按功能）、回复修剪等设置（以后随同步走）
 * - secrets：API Key，只存这台设备，永远不进同步数据
 * - assets：生成的图片、语音（按内容哈希存；以后同步时传到 R2）
 * - rhythm：节律（每个角色的设置和模板、每天的作息穿着、"建世界"生成的世界）
 * - gallery：图库（一起做事时画的图：哪个角色、哪个场景、哪个时刻、穿的什么）
 * - memories / slices / summaries / profiles：记忆（事实记忆、故事片段、时间线、画像卡），按条写入，不整表比较
 * - moments：朋友圈（她们发的、你发的，连同点赞和评论），一条一条存
 */
const STORES = ['characters', 'lorebooks', 'presets', 'chats', 'messages', 'settings', 'secrets', 'assets', 'books', 'rhythm', 'gallery', 'memories', 'slices', 'summaries', 'profiles', 'live2d', 'moments'] as const;
export type StoreName = (typeof STORES)[number];

export const databaseState = reactive({ status: 'opening' as 'opening' | 'blocked' | 'ready' | 'error' | 'outdated' });
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  // 别的页面已升级：这页的内存快照可能过时，重新加载前不能再写回。
  if (databaseState.status === 'outdated') return Promise.reject(new Error('请重新打开 App 以读取更新后的本机数据'));
  if (opening) return opening;
  databaseState.status = 'opening';
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    function request(version?: number) {
      try {
        const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = () => {
          const db = req.result;
          // 旧缓存页面也能读已经升级的库，但绝不降级、删库或重建已有表。
          if (STORES.some((s) => !db.objectStoreNames.contains(s))) {
            db.close();
            reject(new Error('本机数据需要更新版本的 App 才能读取'));
            return;
          }
          db.onversionchange = () => {
            db.close();
            if (opening === pending) opening = null;
            databaseState.status = 'outdated';
          };
          db.onclose = () => {
            if (opening === pending) {
              opening = null;
              databaseState.status = 'error';
            }
          };
          databaseState.status = 'ready';
          resolve(db);
        };
        req.onerror = () => {
          if (version !== undefined && req.error?.name === 'VersionError') request();
          else reject(req.error ?? new Error('无法打开本机数据'));
        };
        // 占用解除后同一个请求会继续，不能把 blocked 当成一个空数据库。
        req.onblocked = () => { databaseState.status = 'blocked'; };
      } catch (error) {
        reject(error);
      }
    }
    request(VERSION);
  });
  opening = pending;
  void pending.catch(() => {
    if (opening === pending) {
      opening = null;
      databaseState.status = 'error';
    }
  });
  return pending;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 读失败必须向上传递；只有成功读完事务才能把不存在的记录当成空数据。 */
async function read<T>(store: StoreName, request: (os: IDBObjectStore) => () => T): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const result = request(tx.objectStore(store));
    tx.oncomplete = () => resolve(result());
    tx.onerror = () => reject(tx.error ?? new Error('本机数据读取失败'));
    tx.onabort = () => reject(tx.error ?? new Error('本机数据读取中断'));
  });
}

export function getAll<T>(store: StoreName): Promise<T[]> {
  return read(store, (os) => {
    const req = os.getAll();
    return () => req.result as T[];
  });
}

export function getOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  return read(store, (os) => {
    const req = os.get(key);
    return () => req.result as T | undefined;
  });
}

/** 读出整张表：键和值一起（getAll 只给值） */
export function getEntries<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
  return read(store, (os) => {
    const keysReq = os.getAllKeys();
    const valuesReq = os.getAll();
    return () => (valuesReq.result as T[]).map((value, i) => ({ key: String(keysReq.result[i]), value }));
  });
}

export async function write(store: StoreName, puts: { key: string; value: unknown }[], dels: string[] = []): Promise<boolean> {
  if (!puts.length && !dels.length) return true;
  try {
    const db = await open();
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
  let saving = 0;
  let revision = 0;
  let committed = 0;
  const pendingKeys = new Set<string>();

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    // pagehide / 切后台也会调用 flush，不能绕过 hydrate 前的暂停状态。
    if (paused || databaseState.status === 'outdated') return;
    const puts: { key: string; value: unknown }[] = [];
    const snapshot = new Map<string, string>();
    for (const { key, value } of source()) {
      const json = JSON.stringify(value);
      snapshot.set(key, json);
      // 前一次写入未完成时仍提交最新快照，包含用户迅速撤回的改动。
      if (!saving && last.get(key) === json) continue;
      puts.push({ key, value: JSON.parse(json) });
    }
    const dels = [...new Set([...last.keys(), ...pendingKeys])].filter((k) => !snapshot.has(k));
    if (!puts.length && !dels.length) return;
    const current = ++revision;
    saving++;
    for (const { key } of puts) pendingKeys.add(key);
    const saved = await write(store, puts, dels);
    saving--;
    if (saved && current > committed) {
      committed = current;
      last.clear();
      for (const [key, json] of snapshot) last.set(key, json);
    }
    if (!saving) pendingKeys.clear();
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
