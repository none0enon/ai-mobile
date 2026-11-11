import { reactive } from 'vue';

/**
 * 装成 App（PWA）：
 * - 注册 Service Worker（sw.js 不走 HTTP 缓存，改了马上生效）；
 * - 接住浏览器的"可以安装"事件，"我的 → 装成 App"里用自己的按钮弹出安装（浏览器自带的安装提示被关掉一次后几个月不再出现）；
 * - 卸载后装不回去时，清理 Service Worker 和缓存再刷新（聊天、角色、Key 存在 IndexedDB，不受影响）。
 *
 * 以前 manifest 的 id 写的是 "./"：浏览器按站点根目录解析，得到 https://none0enon.github.io/，
 * 和同一个 github.io 下其他网页 App 的身份撞在一起，卸载 / 重装时浏览器认错了 App。现在 id 是 /ai-mobile/。
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const pwa = reactive({
  /** 浏览器说现在可以安装（有安装按钮） */
  canPrompt: false,
  /** 现在是装好的 App（全屏打开），不是在浏览器里 */
  standalone: false,
  /** 这次打开时刚装好 */
  justInstalled: false,
  /** Service Worker 注册上了 */
  swReady: false,
  swError: '',
});

let deferred: InstallPromptEvent | null = null;

export function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export type Platform = 'ios' | 'android' | 'desktop';

export function platform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

/** 启动时调用一次（正式构建才注册 Service Worker；单文件预览版不注册） */
export function initPwa(registerWorker: boolean): void {
  pwa.standalone = isStandalone();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    pwa.canPrompt = true;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    pwa.canPrompt = false;
    pwa.justInstalled = true;
  });
  try {
    window.matchMedia('(display-mode: standalone)').addEventListener('change', () => (pwa.standalone = isStandalone()));
  } catch {
    // 老浏览器
  }
  if (!registerWorker || !('serviceWorker' in navigator)) return;
  const register = () =>
    navigator.serviceWorker
      .register('./sw.js', { scope: './', updateViaCache: 'none' })
      .then((reg) => {
        pwa.swReady = true;
        void reg.update().catch(() => undefined);
      })
      .catch((e: unknown) => {
        pwa.swError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      });
  if (document.readyState === 'complete') void register();
  else window.addEventListener('load', () => void register(), { once: true });
}

/** 弹出浏览器的安装确认；浏览器没给安装机会时返回 unavailable */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null;
  pwa.canPrompt = false;
  await e.prompt();
  const choice = await e.userChoice;
  return choice.outcome;
}

/**
 * 清理安装数据：注销这个网页的 Service Worker、删掉全部缓存，然后刷新。
 * 浏览器重新读 manifest、重新注册，卸载后装不回去的情况多数就好了。IndexedDB（聊天、角色、Key）不动。
 */
export async function resetInstallData(): Promise<{ workers: number; caches: number }> {
  let workers = 0;
  let cleared = 0;
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => [] as readonly ServiceWorkerRegistration[]);
    // 只动这个 App 自己的（同一个 github.io 下的其他网页 App 不碰）
    const mine = regs.filter((r) => r.scope.startsWith(new URL('./', location.href).href));
    for (const r of mine) {
      r.active?.postMessage('clear-caches');
      if (await r.unregister().catch(() => false)) workers += 1;
    }
  }
  if ('caches' in window) {
    const keys = await caches.keys().catch(() => [] as string[]);
    for (const k of keys.filter((x) => x.startsWith('ai-mobile-'))) if (await caches.delete(k).catch(() => false)) cleared += 1;
  }
  return { workers, caches: cleared };
}

/** 这个 App 自己的 Service Worker、缓存的情况（排查用） */
export async function installInfo(): Promise<{ workers: string[]; caches: string[]; manifestId: string }> {
  const workers =
    'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations().catch(() => [] as readonly ServiceWorkerRegistration[])).map((r) => `${r.scope}${r.active ? '（运行中）' : r.installing ? '（安装中）' : r.waiting ? '（等待中）' : ''}`) : [];
  const keys = 'caches' in window ? await caches.keys().catch(() => [] as string[]) : [];
  let manifestId = '';
  try {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href;
    if (href) {
      const m = (await (await fetch(href, { cache: 'no-store' })).json()) as { id?: string; start_url?: string };
      const start = new URL(m.start_url ?? './', href);
      manifestId = m.id ? new URL(m.id, start.origin).href : start.href;
    }
  } catch {
    manifestId = '读不到 manifest';
  }
  return { workers, caches: keys, manifestId };
}
