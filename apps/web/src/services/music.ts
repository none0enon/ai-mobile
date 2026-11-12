import type { MusicClient, SongInfo, SongList } from './types';
import { MockMusic } from './mock/others';
import { useServicesStore } from '@/stores/services';

/**
 * 网易云音乐（同 SleepTogether 的 config/netease-manager.js）：浏览器不能直接请求 music.163.com（跨域 + 加密签名），
 * 所以对接你自己部署的 Netease_url Cloudflare Worker（SleepTogether 用的就是它，填同一个地址就行）。
 * Worker 的接口都是 POST JSON，返回 { status, success, message, data }：
 *   /search   { keyword, limit, cookie? }   → data: [歌…]
 *   /song     { id, level, cookie? }        → data: 歌（带 url）
 *   /lyric    { id, cookie? }               → data: { lrc, tlyric, klyric }
 *   /playlist { id, cookie? }               → data: { name, coverImgUrl, tracks }
 *   /album    { id, cookie? }               → data: { name, picUrl, songs }
 *   GET /health                             → data: { name, version }
 * 黑胶 Cookie（MUSIC_U=…）可选，只存在这台设备，随请求发给你自己的 Worker；填了能解析无损和会员歌曲。
 * 歌曲地址大约 20 分钟过期：播放前现取，播放出错时重取（services/musicPlayer.ts）。
 */

export class MusicError extends Error {
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.name = 'MusicError';
    this.detail = detail;
  }
}

/** 网易云的图片和音频地址常是 http：在 https 页面里会被拦，换成 https（网易云的 CDN 都支持） */
export function toHttps(url: string | null | undefined): string {
  if (!url) return '';
  return url.replace(/^http:\/\//i, 'https://');
}

/** 没有封面时唱片的颜色：按歌的 id 算一个色相 */
export function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

type Raw = Record<string, unknown>;
const str = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '');

function namesOf(x: unknown): string {
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map((a) => (typeof a === 'string' ? a : str((a as Raw)?.name))).filter(Boolean).join(' / ');
  return '';
}

/** Worker 返回的一首歌 → SongInfo（兼容几种写法：artists 是字符串或数组、album 是字符串或对象、网易云原始的 ar / al / dt） */
export function normalizeSong(x: unknown): SongInfo | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Raw;
  const id = str(r.id ?? r.songId);
  const title = str(r.name ?? r.title);
  if (!id || !title) return null;
  const albumObj = (r.album && typeof r.album === 'object' ? r.album : r.al) as Raw | undefined;
  const album = typeof r.album === 'string' ? r.album : str(albumObj?.name);
  const cover = toHttps(str(r.picUrl ?? r.cover ?? r.pic ?? albumObj?.picUrl)) || null;
  let duration = Number(r.duration ?? r.dt ?? r.durationMs ?? 0);
  // 有的版本给的是秒
  if (duration > 0 && duration < 3600) duration *= 1000;
  return {
    id,
    title,
    artist: namesOf(r.artists ?? r.ar ?? r.artist ?? r.singer) || '未知歌手',
    ...(album ? { album } : {}),
    cover,
    durationMs: Number.isFinite(duration) ? Math.round(duration) : 0,
    hue: hueOf(id),
  };
}

/**
 * 歌单 / 专辑 / 歌的链接里取出 id：music.163.com/#/playlist?id=123、/playlist/123、分享出来的整段文字……
 * 取不出来（例如 163cn.tv 短链接）时原样交给 Worker
 */
export function extractId(input: string): string {
  const t = input.trim();
  if (/^\d+$/.test(t)) return t;
  const m = t.match(/[?&#]id=(\d+)/) ?? t.match(/\/(?:playlist|album|song)\/(\d+)/);
  return m?.[1] ?? t;
}

function lyricText(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') return str((x as Raw).lyric);
  return '';
}

async function call<T>(path: string, payload: Raw, signal?: AbortSignal): Promise<T> {
  const svc = useServicesStore();
  const base = svc.neteaseBase;
  if (!base) throw new MusicError('还没填网易云 Worker 的地址（我的 → 地图、天气、音乐）');
  const cookie = svc.neteaseCookie;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cookie ? { ...payload, cookie } : payload),
      signal: signal ?? AbortSignal.timeout?.(30_000),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new MusicError(`连不上网易云 Worker：${e instanceof Error ? e.message : String(e)}`, `${base}${path}`);
  }
  const text = await res.text();
  let data: { success?: boolean; message?: string; data?: unknown } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new MusicError(`网易云 Worker 返回的不是 JSON（HTTP ${res.status}）`, text.slice(0, 1000));
  }
  if (!res.ok || data?.success === false) throw new MusicError(data?.message || `网易云 Worker 返回 ${res.status}`, text.slice(0, 1000));
  return data?.data as T;
}

export interface WorkerInfo {
  name?: string;
  version?: string;
}

/** 测试连接：GET /health */
export async function pingNetease(base: string): Promise<WorkerInfo> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout?.(15_000) });
  } catch (e) {
    throw new MusicError(`连不上：${e instanceof Error ? e.message : String(e)}（地址对吗？Worker 部署好了吗？）`);
  }
  const text = await res.text();
  let data: { success?: boolean; message?: string; data?: WorkerInfo } | null = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MusicError(`返回的不是 Netease_url Worker（HTTP ${res.status}）`, text.slice(0, 600));
  }
  if (!res.ok || data?.success === false) throw new MusicError(data?.message || `HTTP ${res.status}`, text.slice(0, 600));
  return data?.data ?? {};
}

export class NeteaseMusic implements MusicClient {
  readonly ready = true;

  async search(keyword: string, limit = 30): Promise<SongInfo[]> {
    const list = await call<unknown[]>('/search', { keyword: keyword.trim(), limit });
    return (Array.isArray(list) ? list : []).map(normalizeSong).filter((s): s is SongInfo => !!s);
  }

  async resolve(id: string): Promise<{ url: string; expiresAt: number; level?: string }> {
    const svc = useServicesStore();
    const song = await call<Raw | null>('/song', { id, level: svc.netease.quality });
    const url = toHttps(str(song?.url));
    if (!url) {
      throw new MusicError(
        '这首歌拿不到播放地址：可能是版权或地区限制（在国外时更常见），或者要黑胶会员；可以在设置里填黑胶 Cookie，或者换一首',
        JSON.stringify(song ?? null).slice(0, 600),
      );
    }
    return { url, expiresAt: Date.now() + 20 * 60_000, ...(str(song?.level) ? { level: str(song?.level) } : {}) };
  }

  async lyric(id: string): Promise<{ lrc: string; tlyric?: string }> {
    const data = await call<Raw | null>('/lyric', { id });
    const lrc = lyricText(data?.lrc);
    const tlyric = lyricText(data?.tlyric);
    return { lrc, ...(tlyric ? { tlyric } : {}) };
  }

  async playlist(idOrUrl: string): Promise<SongList> {
    const data = await call<Raw | null>('/playlist', { id: extractId(idOrUrl) });
    const tracks = (Array.isArray(data?.tracks) ? data.tracks : []).map(normalizeSong).filter((s): s is SongInfo => !!s);
    return { name: str(data?.name) || '歌单', cover: toHttps(str(data?.coverImgUrl ?? data?.picUrl)) || tracks[0]?.cover || null, songs: tracks };
  }

  async album(idOrUrl: string): Promise<SongList> {
    const data = await call<Raw | null>('/album', { id: extractId(idOrUrl) });
    const songs = (Array.isArray(data?.songs) ? data.songs : []).map(normalizeSong).filter((s): s is SongInfo => !!s);
    return { name: str(data?.name) || '专辑', cover: toHttps(str(data?.picUrl ?? data?.coverImgUrl)) || songs[0]?.cover || null, songs };
  }
}

/** 填了 Worker 地址用网易云，没填用演示（虚构的歌、不出声） */
export class RoutedMusic implements MusicClient {
  private readonly real = new NeteaseMusic();
  private readonly demo = new MockMusic();

  get ready(): boolean {
    try {
      return useServicesStore().musicReady;
    } catch {
      return false;
    }
  }
  private get impl(): MusicClient {
    return this.ready ? this.real : this.demo;
  }
  search(keyword: string, limit?: number) {
    return this.impl.search(keyword, limit);
  }
  resolve(id: string) {
    return this.impl.resolve(id);
  }
  lyric(id: string) {
    return this.impl.lyric(id);
  }
  playlist(idOrUrl: string) {
    return this.impl.playlist(idOrUrl);
  }
  album(idOrUrl: string) {
    return this.impl.album(idOrUrl);
  }
}
