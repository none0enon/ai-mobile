import { lrcIndexAt, parseLrc, type LrcLine } from '@app/shared';
import { reactive } from 'vue';
import { playbackSession } from './audio';
import { services } from './index';
import type { SongInfo } from './types';

/**
 * 一起听歌的播放器（同 SleepTogether 的网易云面板：播放器放在模块里，离开页面不断）：
 * - 去聊天、打电话时还在放（还算"在一起"），离开这件事（ScenePage 的 leaveScene）时停；
 * - 歌曲地址播放前现取（约 20 分钟过期），播放出错先重取一次地址接着放，还不行就跳下一首；
 * - 播放列表、播放模式记在本机，下次打开还在（不自动播放）；
 * - 锁屏 / 通知栏的播放控制（Media Session）；iPhone 静音键打开时也有声（audioSession = playback）。
 * 没填网易云 Worker 时是演示：虚构的歌、不出声，进度按时间走。
 */

export type PlayMode = 'list' | 'single' | 'shuffle';

export interface PlayerState {
  queue: SongInfo[];
  index: number;
  mode: PlayMode;
  playing: boolean;
  /** 正在取播放地址 */
  loading: boolean;
  posMs: number;
  durationMs: number;
  /** 最近一次出错（地址取不到、播放失败） */
  error: string;
  lines: LrcLine[];
  lyricState: 'idle' | 'loading' | 'ok' | 'none' | 'error';
  /** 演示：不出声 */
  demo: boolean;
  /** 实际拿到的音质 */
  level: string;
  volume: number;
  /** 被浏览器拦了自动播放，要点一下播放 */
  needsTap: boolean;
}

const QUEUE_KEY = 'ai-mobile:music:queue:v1';

function readQueue(): Pick<PlayerState, 'queue' | 'index' | 'mode'> {
  try {
    const v = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? 'null') as Partial<PlayerState> | null;
    if (v && Array.isArray(v.queue)) {
      const index = typeof v.index === 'number' && v.index < v.queue.length ? v.index : -1;
      const mode = v.mode === 'single' || v.mode === 'shuffle' ? v.mode : 'list';
      return { queue: v.queue, index, mode };
    }
  } catch {
    // 读不出来就从空的开始
  }
  return { queue: [], index: -1, mode: 'list' };
}

export const player = reactive<PlayerState>({
  ...readQueue(),
  playing: false,
  loading: false,
  posMs: 0,
  durationMs: 0,
  error: '',
  lines: [],
  lyricState: 'idle',
  demo: false,
  level: '',
  volume: 1,
  needsTap: false,
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify({ queue: player.queue.slice(0, 300), index: player.index, mode: player.mode }));
    } catch {
      // 存不了也不影响播放
    }
  }, 400);
}

export function current(): SongInfo | null {
  return player.index >= 0 ? (player.queue[player.index] ?? null) : null;
}

/** 现在唱到第几行 */
export function lyricIndex(): number {
  return lrcIndexAt(player.lines, player.posMs);
}

// —— <audio> ——

let audio: HTMLAudioElement | null = null;
let primed = false;
let url = '';
let expiresAt = 0;
let retried = false;
let token = 0;
let releaseSession: (() => void) | null = null;
let demoTimer: ReturnType<typeof setInterval> | undefined;
/** 这一次一起听了哪些歌（离开时记进聊天） */
const played: string[] = [];
const listeners = new Set<(e: PlayerEvent) => void>();

export type PlayerEvent = { kind: 'track'; song: SongInfo } | { kind: 'seek' } | { kind: 'stop' };
/** 换歌、拖进度、停下时通知（场景里排她的弹幕用） */
export function onPlayerEvent(cb: (e: PlayerEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit(e: PlayerEvent) {
  for (const cb of listeners) cb(e);
}

/** 现在放的是不是真的歌（不是解锁用的那段静音） */
function isSong(a: HTMLAudioElement): boolean {
  return !!url && a.src === url;
}

function el(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = 'auto';
  a.setAttribute('playsinline', '');
  a.volume = player.volume;
  // 解锁用的静音片段也会触发这些事件（而且一放就完）：只认真的歌
  a.addEventListener('timeupdate', () => {
    if (!player.demo && isSong(a)) player.posMs = Math.round(a.currentTime * 1000);
  });
  a.addEventListener('loadedmetadata', () => {
    if (isSong(a) && Number.isFinite(a.duration) && a.duration > 0) player.durationMs = Math.round(a.duration * 1000);
  });
  a.addEventListener('play', () => {
    if (!isSong(a)) return;
    player.playing = true;
    player.needsTap = false;
    releaseSession ??= playbackSession();
    setMediaState('playing');
  });
  a.addEventListener('pause', () => {
    if (!isSong(a)) return;
    player.playing = false;
    setMediaState('paused');
  });
  a.addEventListener('ended', () => {
    if (!isSong(a)) return;
    if (player.mode === 'single') {
      a.currentTime = 0;
      void a.play().catch(() => undefined);
      emit({ kind: 'seek' });
    } else void next();
  });
  a.addEventListener('error', () => void onAudioError());
  audio = a;
  return a;
}

/**
 * 在点击里调用：iPhone 上只有在用户点过之后"解锁"过的 <audio> 才能在网络请求之后播放。
 * 先用一段静音放一下，等取到歌曲地址再换成真的
 */
export function prime() {
  if (primed || player.demo) return;
  const a = el();
  primed = true;
  if (a.src) return;
  a.muted = true;
  a.src = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';
  a.play()
    .then(() => {
      // 这期间可能已经换成真的歌了：那就别停
      if (!isSong(a)) a.pause();
      a.muted = false;
    })
    .catch(() => {
      a.muted = false;
      primed = false;
    });
}

async function onAudioError() {
  const song = current();
  if (!song || player.demo || !url) return;
  const mine = token;
  // 地址过期或者临时出错：重取一次地址，从刚才的位置接着放
  if (!retried) {
    retried = true;
    const at = player.posMs;
    try {
      const r = await services.music.resolve(song.id);
      if (mine !== token) return;
      url = r.url;
      expiresAt = r.expiresAt;
      const a = el();
      a.src = url;
      a.currentTime = at / 1000;
      await a.play();
      return;
    } catch {
      // 落到下面
    }
  }
  if (mine !== token) return;
  player.error = `《${song.title}》放不出来（地址失效或者被限制），跳到下一首`;
  player.playing = false;
  if (player.queue.length > 1) setTimeout(() => mine === token && void next(), 1200);
}

// —— 锁屏控制 ——

function setMediaState(state: 'playing' | 'paused' | 'none') {
  try {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  } catch {
    // 不支持就算了
  }
}

function setMediaMetadata(song: SongInfo) {
  try {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: song.album ?? '',
      artwork: song.cover ? [{ src: song.cover, sizes: '512x512' }] : [],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => void toggle(true));
    ms.setActionHandler('pause', () => void toggle(false));
    ms.setActionHandler('previoustrack', () => void prev());
    ms.setActionHandler('nexttrack', () => void next());
    ms.setActionHandler('seekto', (d) => typeof d.seekTime === 'number' && seek(d.seekTime * 1000));
  } catch {
    // 有的浏览器不认某些动作
  }
}

// —— 演示（不出声，进度按时间走） ——

function startDemoClock() {
  clearInterval(demoTimer);
  demoTimer = setInterval(() => {
    if (!player.playing || !player.demo) return;
    player.posMs += 250;
    if (player.durationMs && player.posMs >= player.durationMs) {
      player.posMs = 0;
      if (player.mode !== 'single') void next();
      else emit({ kind: 'seek' });
    }
  }, 250);
}

// —— 歌词 ——

async function loadLyrics(song: SongInfo, mine: number) {
  player.lines = [];
  player.lyricState = 'loading';
  try {
    const { lrc, tlyric } = await services.music.lyric(song.id);
    if (mine !== token) return;
    const lines = parseLrc(lrc, tlyric);
    player.lines = lines;
    player.lyricState = lines.length ? 'ok' : 'none';
  } catch {
    if (mine === token) player.lyricState = 'error';
  }
}

// —— 播放控制 ——

/** 放第 i 首：取地址（演示不取）→ 播放 → 取歌词 */
export async function playAt(i: number): Promise<void> {
  const song = player.queue[i];
  if (!song) return;
  const mine = ++token;
  player.index = i;
  player.error = '';
  player.posMs = 0;
  player.durationMs = song.durationMs;
  player.level = '';
  player.demo = !services.music.ready;
  retried = false;
  persist();
  setMediaMetadata(song);
  if (!played.includes(song.title)) played.push(song.title);
  emit({ kind: 'track', song });
  void loadLyrics(song, mine);
  if (player.demo) {
    audio?.pause();
    player.playing = true;
    startDemoClock();
    return;
  }
  clearInterval(demoTimer);
  player.loading = true;
  const a = el();
  a.pause();
  try {
    const r = await services.music.resolve(song.id);
    if (mine !== token) return;
    url = r.url;
    expiresAt = r.expiresAt;
    player.level = r.level ?? '';
    a.src = url;
    a.volume = player.volume;
    try {
      await a.play();
    } catch (e) {
      if (mine !== token) return;
      if ((e as DOMException)?.name === 'NotAllowedError') {
        player.needsTap = true;
        player.playing = false;
      } else throw e;
    }
  } catch (e) {
    if (mine !== token) return;
    player.playing = false;
    player.error = e instanceof Error ? e.message : String(e);
    // 这首拿不到地址：几秒后自动跳下一首，免得卡住
    if (player.queue.length > 1) setTimeout(() => mine === token && void next(), 2500);
  } finally {
    if (mine === token) player.loading = false;
  }
}

/** 换一个列表从第 start 首开始放 */
export function playList(songs: SongInfo[], start = 0): Promise<void> {
  player.queue = songs.slice();
  return playAt(Math.max(0, Math.min(start, songs.length - 1)));
}

/** 放这首：已经在列表里就跳过去，不在就插到当前这首后面 */
export function playSong(song: SongInfo): Promise<void> {
  const at = player.queue.findIndex((s) => s.id === song.id);
  if (at >= 0) return playAt(at);
  const i = player.index >= 0 ? player.index + 1 : player.queue.length;
  player.queue.splice(i, 0, song);
  return playAt(i);
}

export function enqueue(songs: SongInfo[]) {
  const fresh = songs.filter((s) => !player.queue.some((q) => q.id === s.id));
  const wasEmpty = !player.queue.length;
  player.queue.push(...fresh);
  persist();
  if (wasEmpty && fresh.length) void playAt(0);
  return fresh.length;
}

export function removeAt(i: number) {
  if (i < 0 || i >= player.queue.length) return;
  const wasCurrent = i === player.index;
  player.queue.splice(i, 1);
  if (wasCurrent) {
    if (player.queue.length) void playAt(Math.min(i, player.queue.length - 1));
    else stop();
  } else if (i < player.index) player.index -= 1;
  persist();
}

export function clearQueue() {
  stop();
  player.queue = [];
  player.index = -1;
  persist();
}

function randomIndex(): number {
  if (player.queue.length <= 1) return 0;
  let i = player.index;
  while (i === player.index) i = Math.floor(Math.random() * player.queue.length);
  return i;
}

export function next(): Promise<void> {
  if (!player.queue.length) return Promise.resolve();
  if (player.mode === 'shuffle') return playAt(randomIndex());
  return playAt((player.index + 1) % player.queue.length);
}

export function prev(): Promise<void> {
  if (!player.queue.length) return Promise.resolve();
  // 放了 3 秒以上：先回到这首开头
  if (player.posMs > 3000) {
    seek(0);
    return Promise.resolve();
  }
  if (player.mode === 'shuffle') return playAt(randomIndex());
  return playAt((player.index - 1 + player.queue.length) % player.queue.length);
}

/** 播放 / 暂停；on 指定要哪个 */
export async function toggle(on?: boolean): Promise<void> {
  const want = on ?? !player.playing;
  if (!current()) {
    if (want && player.queue.length) await playAt(0);
    return;
  }
  if (player.demo) {
    player.playing = want;
    if (want) startDemoClock();
    return;
  }
  const a = el();
  if (!want) {
    a.pause();
    return;
  }
  // 还没取过地址（刚打开、恢复的列表），或者地址快过期了：重新取
  if (!a.src || a.src.startsWith('data:') || !url || Date.now() > expiresAt - 60_000) {
    const at = player.posMs;
    await playAt(player.index);
    if (at > 0) seek(at);
    return;
  }
  try {
    await a.play();
  } catch (e) {
    if ((e as DOMException)?.name === 'NotAllowedError') player.needsTap = true;
    else player.error = e instanceof Error ? e.message : String(e);
  }
}

export function seek(ms: number) {
  const t = Math.max(0, ms);
  player.posMs = t;
  if (!player.demo && audio && url) audio.currentTime = t / 1000;
  emit({ kind: 'seek' });
}

export function setVolume(v: number) {
  player.volume = Math.max(0, Math.min(1, v));
  if (audio) audio.volume = player.volume;
}

export function cycleMode() {
  const order: PlayMode[] = ['list', 'single', 'shuffle'];
  player.mode = order[(order.indexOf(player.mode) + 1) % order.length]!;
  persist();
}

/** 这一次一起听了什么："一起听了《A》《B》等 5 首"；一首都没放过时为空 */
export function sessionSummary(): string | undefined {
  if (!played.length) return undefined;
  const names = played.slice(0, 3).map((t) => `《${t}》`).join('');
  return `一起听了${names}${played.length > 3 ? `等 ${played.length} 首` : ''}`;
}

/** 不听了（离开"一起听歌"）：停下、松开 iPhone 的音频会话；列表留着 */
export function stop() {
  token += 1;
  played.length = 0;
  clearInterval(demoTimer);
  audio?.pause();
  if (audio) {
    audio.removeAttribute('src');
    audio.load();
  }
  url = '';
  player.playing = false;
  player.loading = false;
  player.posMs = 0;
  releaseSession?.();
  releaseSession = null;
  setMediaState('none');
  emit({ kind: 'stop' });
}
