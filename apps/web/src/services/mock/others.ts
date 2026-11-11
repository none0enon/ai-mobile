import type { MapLocation } from '@app/shared';
import type {
  EmbeddingClient,
  LatLng,
  MapsClient,
  MusicClient,
  NativeBridge,
  PushClient,
  RealPlaceKind,
  STTClient,
  SongInfo,
  SyncClient,
  SyncStatus,
  TTSClient,
  WeatherClient,
} from '../types';
import { weather } from '@/mock/activity';
import { lyricLrc, lyricTranslation, songs } from '@/mock/music';
import { NEARBY_PLACES } from '@/mock/realworld';
import { sleep } from '@/utils/id';

/** 假 TTS：不出声，只按字数估一个时长，期间不停报"音量"驱动声波和口型 */
export class MockTTS implements TTSClient {
  private ctrl: AbortController | null = null;

  async speak(text: string, opts?: { onLevel?(level: number): void; signal?: AbortSignal }): Promise<void> {
    this.stop();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    opts?.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    const total = Math.max(800, text.length * 170);
    const started = Date.now();
    try {
      while (Date.now() - started < total) {
        opts?.onLevel?.(0.25 + Math.random() * 0.75);
        await sleep(90, ctrl.signal);
      }
    } catch {
      // 被打断（用户开口 / 挂断）
    } finally {
      opts?.onLevel?.(0);
    }
  }

  stop(): void {
    this.ctrl?.abort();
    this.ctrl = null;
  }
}

export class MockSTT implements STTClient {
  private lines = ['今天有点累', '你在干嘛呀', '我想听你说话', '晚安'];
  private i = 0;
  async transcribe(): Promise<string> {
    await sleep(500);
    const line = this.lines[this.i % this.lines.length] ?? '';
    this.i += 1;
    return line;
  }
}

/**
 * 假向量：字符二元组哈希到 256 维再归一化。只为"测试相似度"按钮有个像样的数字，
 * 真实版本调你在"智能体分配"里选的 Embedding 接口。
 */
export class MockEmbedding implements EmbeddingClient {
  readonly live = false;
  readonly model = 'BAAI/bge-m3（演示）';
  readonly dims = 256;

  async embed(texts: string[]): Promise<Float32Array[]> {
    await sleep(260);
    return texts.map((t) => {
      const v = new Float32Array(this.dims);
      const s = t.replace(/\s+/g, '');
      for (let i = 0; i < s.length; i += 1) {
        const gram = s.slice(i, i + 2);
        let h = 2166136261;
        for (const ch of gram) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
        v[Math.abs(h) % this.dims] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export class MockMusic implements MusicClient {
  async search(keyword: string): Promise<SongInfo[]> {
    await sleep(300);
    const k = keyword.trim();
    return k ? songs.filter((s) => s.title.includes(k) || s.artist.includes(k)) : songs;
  }
  async resolve(id: string) {
    await sleep(120);
    return { url: `https://music.example/${id}.mp3`, expiresAt: Date.now() + 20 * 60_000 };
  }
  async lyric() {
    await sleep(120);
    return { lrc: lyricLrc, tlyric: lyricTranslation };
  }
}

export class MockWeather implements WeatherClient {
  async now() {
    await sleep(100);
    return weather;
  }
}

export class MockSync implements SyncClient {
  private s: SyncStatus = {
    mode: 'hub',
    state: 'idle',
    lastSyncAt: Date.now() - 4 * 60_000,
    pending: 0,
    devices: [
      { name: '这台设备', platform: '浏览器', lastSeen: Date.now(), current: true },
      { name: '我的安卓手机', platform: 'Android APK', lastSeen: Date.now() - 25 * 60_000, current: false },
      { name: 'iPhone', platform: 'iOS 主屏 PWA', lastSeen: Date.now() - 3 * 3600_000, current: false },
    ],
  };
  status(): SyncStatus {
    return this.s;
  }
  async syncNow(): Promise<SyncStatus> {
    this.s = { ...this.s, state: 'syncing' };
    await sleep(900);
    this.s = { ...this.s, state: 'idle', lastSyncAt: Date.now(), pending: 0 };
    return this.s;
  }
}

export class MockPush implements PushClient {
  async test(): Promise<boolean> {
    await sleep(600);
    return true;
  }
}

export function createNativeBridge(): NativeBridge {
  const isApp = typeof window !== 'undefined' && !!window.AiCompanionNative;
  const standalone = typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches;
  let lock: { release(): Promise<void> } | null = null;
  return {
    platform: isApp ? 'android' : standalone ? 'pwa' : 'web',
    vibrate(pattern) {
      try {
        if (isApp) window.AiCompanionNative?.vibrate(JSON.stringify(pattern));
        else navigator.vibrate?.(pattern);
      } catch {
        // 有些浏览器不支持震动
      }
    },
    async keepAwake(on) {
      try {
        if (on && !lock) lock = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
        if (!on && lock) {
          await lock.release();
          lock = null;
        }
      } catch {
        // 不支持或被拒绝时忽略
      }
    },
  };
}

/** 地图：没有 Google Maps Key 时的假实现，返回演示用的附近地点 */
export class MockMaps implements MapsClient {
  readonly ready = false;
  async geocode(): Promise<LatLng | null> {
    return null;
  }
  async whereAmI(): Promise<LatLng | null> {
    return null;
  }
  async nearby(_center: LatLng | null, kinds: RealPlaceKind[]): Promise<MapLocation[]> {
    const KIND_OF: Record<string, RealPlaceKind> = {
      'real:cafe': 'cafe',
      'real:ramen': 'restaurant',
      'real:park': 'park',
      'real:gym': 'gym',
      'real:library': 'library',
    };
    return NEARBY_PLACES.filter((p) => kinds.includes(KIND_OF[p.id] ?? 'cafe'));
  }
}
