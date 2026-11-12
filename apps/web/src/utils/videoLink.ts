/**
 * 一起观影贴的链接（参考 siios 的 co-watch-prompt.js / co-watch.js）：
 * - YouTube（watch、youtu.be、shorts、embed、live、music）→ 官方嵌入播放器，带 enablejsapi=1，网页能读到播放时间；
 * - B 站（链接里有 BV 号或 av 号）→ 官方嵌入播放器 player.bilibili.com，不用登录、不用自己的服务器；
 *   嵌入播放器不告诉网页播到哪了，时间靠你点"开始计时"；
 * - 直接指向视频文件的链接（.mp4 / .webm / .m3u8 …）→ 用 App 自己的播放器，时间精确；
 * - 也可以直接粘贴 App 里"分享"复制的整段文字："【标题】 https://b23.tv/…"，标题顺手取出来。
 * 认不出的网址不塞进 iframe（不会把任意网页嵌进来），而是当作视频文件试着放，放不了就提示。
 */

export type VideoPlatform = 'youtube' | 'bilibili' | 'direct';

export interface VideoLink {
  platform: VideoPlatform;
  /** 贴进来的链接 */
  url: string;
  /** 播放器地址：嵌入播放器的 iframe 地址，或视频文件地址 */
  src: string;
  /** 在原平台上看的地址 */
  watchUrl: string;
  /** YouTube 的视频 id、B 站的 BV 号 / av 号 */
  id?: string;
  /** B 站的分 P */
  page?: number;
  /** 分享文字里带的标题 */
  title?: string;
  /** 链接里带的开始时间（秒） */
  start?: number;
  /** m3u8 直播流 / 点播流 */
  hls?: boolean;
  /** 链接里看不出是视频文件，只是试着放 */
  guessed?: boolean;
}

export type ParsedVideoLink = { ok: true; link: VideoLink } | { ok: false; reason: string };

export const PLATFORM_LABEL: Record<VideoPlatform, string> = { youtube: 'YouTube', bilibili: 'B 站', direct: '视频链接' };

const URL_RE = /https?:\/\/[^\s<>"'，。！？、；（）()【】「」]+/i;
const BV_RE = /\b(BV[0-9A-Za-z]{10})\b/;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv)$/i;

/** "90"、"90s"、"1m30s"、"1h2m3s" → 秒 */
function parseStart(v: string | null): number | undefined {
  if (!v) return undefined;
  if (/^\d+(?:\.\d+)?s?$/.test(v)) return Math.floor(parseFloat(v));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v);
  if (!m || !m[0]) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) || undefined;
}

/** 分享文字里的标题："【标题-哔哩哔哩】 链接"（标题里还可能有【】）或链接前面的那段话 */
function titleFrom(text: string, url: string): string | undefined {
  let raw = text.slice(0, Math.max(0, text.indexOf(url))).trim();
  if (raw.startsWith('【') && raw.endsWith('】')) raw = raw.slice(1, -1);
  const t = raw
    .replace(/[-_—]+\s*哔哩哔哩.*$/u, '')
    .replace(/_bilibili$/i, '')
    .replace(/\s*-\s*YouTube$/i, '')
    .trim();
  return t.length >= 2 && t.length <= 80 && !URL_RE.test(t) ? t : undefined;
}

function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^(?:www|m|music)\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0] ?? '';
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') ?? '';
    else id = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? '';
  }
  return /^[\w-]{11}$/.test(id) ? id : null;
}

/**
 * 解析贴进来的东西。空的返回 null。
 * origin：App 自己的地址（YouTube 嵌入播放器只把播放时间发给这个来源）
 */
export function parseVideoLink(input: string, origin?: string): ParsedVideoLink | null {
  const text = input.trim();
  if (!text) return null;
  const urlText = URL_RE.exec(text)?.[0];

  // B 站：BV 号（链接里、短链接里，或者只贴了 BV 号）
  const bv = BV_RE.exec(urlText ?? text)?.[1];
  const isBili = !urlText || /bilibili\.com|b23\.tv/i.test(urlText);
  const av = urlText ? /(?:bilibili\.com\/video\/|b23\.tv\/)av(\d+)/i.exec(urlText)?.[1] : /^av(\d+)$/i.exec(text)?.[1];
  if ((bv && isBili) || av) {
    let page = 1;
    let start: number | undefined;
    if (urlText) {
      try {
        const u = new URL(urlText);
        page = Math.max(1, Number(u.searchParams.get('p')) || 1);
        start = parseStart(u.searchParams.get('t'));
      } catch {
        // 地址不完整
      }
    }
    const idParam = bv ? `bvid=${bv}` : `aid=${av}`;
    const id = bv ?? `av${av}`;
    return {
      ok: true,
      link: {
        platform: 'bilibili',
        url: urlText ?? text,
        id,
        page,
        start,
        src: `https://player.bilibili.com/player.html?${idParam}&page=${page}&autoplay=0&high_quality=1&danmaku=0${start ? `&t=${start}` : ''}`,
        watchUrl: `https://www.bilibili.com/video/${id}${page > 1 ? `?p=${page}` : ''}`,
        title: urlText ? titleFrom(text, urlText) : undefined,
      },
    };
  }
  if (!urlText) return { ok: false, reason: '没找到链接：贴 B 站 / YouTube 的视频链接，或者视频文件的地址' };
  if (/b23\.tv/i.test(urlText)) {
    return {
      ok: false,
      reason: 'b23.tv 短链接在网页里展不开（B 站不让别的网页读它跳到哪）：在浏览器里打开这个短链接，复制地址栏里带 BV 号的地址再贴；或者只贴 BV 号',
    };
  }

  let u: URL;
  try {
    u = new URL(urlText);
  } catch {
    return { ok: false, reason: '这个链接不完整' };
  }

  const yt = youtubeId(u);
  if (yt) {
    const start = parseStart(u.searchParams.get('t') ?? u.searchParams.get('start'));
    const params = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0', modestbranding: '1' });
    if (start) params.set('start', String(start));
    if (origin) params.set('origin', origin);
    return {
      ok: true,
      link: { platform: 'youtube', url: urlText, id: yt, start, src: `https://www.youtube-nocookie.com/embed/${yt}?${params}`, watchUrl: `https://www.youtube.com/watch?v=${yt}`, title: titleFrom(text, urlText) },
    };
  }
  if (/(?:^|\.)(?:youtube\.com|youtu\.be|bilibili\.com)$/i.test(u.hostname)) {
    return { ok: false, reason: '这是 YouTube / B 站的链接，但里面没有视频：要贴某一个视频的页面地址' };
  }

  const hls = /\.m3u8$/i.test(u.pathname);
  return {
    ok: true,
    link: { platform: 'direct', url: urlText, src: urlText, watchUrl: urlText, hls, guessed: !hls && !VIDEO_EXT.test(u.pathname), title: titleFrom(text, urlText) ?? decodeURIComponent(u.pathname.split('/').pop() ?? '').replace(/\.[^.]+$/, '') },
  };
}

/** YouTube 的标题和频道（oEmbed，允许跨域）；失败就是空的，不影响播放 */
export async function fetchYouTubeMeta(watchUrl: string, signal?: AbortSignal): Promise<{ title?: string; author?: string }> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`, { signal });
    if (!res.ok) return {};
    const d = (await res.json()) as { title?: string; author_name?: string };
    return { title: d.title || undefined, author: d.author_name || undefined };
  } catch {
    return {};
  }
}

export interface YouTubeInfo {
  /** 播到第几秒 */
  time?: number;
  /** -1 没开始、0 播完、1 在播、2 暂停、3 缓冲、5 准备好 */
  state?: number;
  duration?: number;
  title?: string;
  author?: string;
}

/**
 * 跟 YouTube 嵌入播放器说话（不用加载 iframe_api 脚本）：先发 listening，之后播放器会不断回 infoDelivery（播放时间、状态）。
 * command('pauseVideo') 之类的也能发
 */
export function trackYouTube(iframe: HTMLIFrameElement, onInfo: (info: YouTubeInfo) => void) {
  let heard = false;
  const onMessage = (e: MessageEvent) => {
    if (!iframe.contentWindow || e.source !== iframe.contentWindow) return;
    let d: unknown = e.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch {
        return;
      }
    }
    const msg = d as { event?: string; info?: unknown };
    if (msg?.event === 'onStateChange' && typeof msg.info === 'number') {
      heard = true;
      onInfo({ state: msg.info });
      return;
    }
    if ((msg?.event === 'infoDelivery' || msg?.event === 'initialDelivery') && msg.info && typeof msg.info === 'object') {
      heard = true;
      const i = msg.info as { currentTime?: number; playerState?: number; duration?: number; videoData?: { title?: string; author?: string } };
      onInfo({
        time: typeof i.currentTime === 'number' ? i.currentTime : undefined,
        state: typeof i.playerState === 'number' ? i.playerState : undefined,
        duration: typeof i.duration === 'number' ? i.duration : undefined,
        title: i.videoData?.title || undefined,
        author: i.videoData?.author || undefined,
      });
    }
  };
  const post = (data: object) => {
    try {
      iframe.contentWindow?.postMessage(JSON.stringify({ ...data, id: 1, channel: 'widget' }), '*');
    } catch {
      // iframe 还没好
    }
  };
  const hello = () => post({ event: 'listening' });
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', hello);
  // 播放器准备好之前发的会丢：前十几秒每秒再说一次，收到回音就停
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (heard || tries > 15) clearInterval(timer);
    else hello();
  }, 1000);
  return {
    get heard() {
      return heard;
    },
    command(func: string, args: unknown[] = []) {
      post({ event: 'command', func, args });
    },
    destroy() {
      clearInterval(timer);
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', hello);
    },
  };
}
