import type { ChatBackground } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, watch } from 'vue';
import { useAppStore } from './app';
import { DEFAULT_PALETTE, paletteVars, seedsOf, type PaletteId } from '@/theme/palettes';
import { uid } from '@/utils/id';
import { compressImage } from '@/utils/image';

/**
 * 外观：配色（白天 / 夜里）、点缀色来源、聊天背景、自己上传的头像。
 * 骨架阶段存在本机 localStorage（图片压缩后单独存）；M1 起改存 IndexedDB，
 * 图片按内容哈希传到 R2，随 Chat.background、Character.avatar、Persona.avatar 同步到其他设备。
 */
const KEY = 'ai-mobile:appearance';
const IMG_PREFIX = 'ai-mobile:img:';

export const DEFAULT_BACKGROUND: Omit<ChatBackground, 'assetKey'> = { dim: 30, blur: 0 };

interface Stored {
  dayPalette: PaletteId;
  nightPalette: PaletteId;
  /** 白天和夜里分开选配色 */
  splitPalettes: boolean;
  accentFrom: 'character' | 'palette';
  chatBackground: ChatBackground | null;
  /** 单个聊天的背景（chatId → 背景）；assetKey 为空 = 这个聊天不用背景图 */
  chatBackgrounds: Record<string, ChatBackground>;
  /** 自己上传的头像：`character:<id>` / `persona:<id>` → 图片 key */
  avatars: Record<string, string>;
}

const DEFAULTS: Stored = {
  dayPalette: DEFAULT_PALETTE,
  nightPalette: DEFAULT_PALETTE,
  splitPalettes: false,
  accentFrom: 'character',
  chatBackground: null,
  chatBackgrounds: {},
  avatars: {},
};

function readJson<T>(key: string): Partial<T> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Partial<T>) : {};
  } catch {
    return {};
  }
}

function tryWrite(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export type AvatarOwner = 'character' | 'persona';

export const useAppearanceStore = defineStore('appearance', () => {
  const app = useAppStore();
  const s = reactive<Stored>({ ...DEFAULTS, ...readJson<Stored>(KEY) });
  /** 图片 key → data URL（内存里一份，localStorage 里一份） */
  const images = reactive<Record<string, string>>({});

  function referencedKeys(): string[] {
    return [s.chatBackground?.assetKey, ...Object.values(s.chatBackgrounds).map((b) => b.assetKey), ...Object.values(s.avatars)].filter(
      (k): k is string => !!k,
    );
  }

  // 启动：读回用到的图片，清掉没人用的
  for (const k of referencedKeys()) {
    try {
      const url = localStorage.getItem(IMG_PREFIX + k);
      if (url) images[k] = url;
    } catch {
      // 读不了就算了，界面会退回默认样子
    }
  }
  try {
    const used = new Set(referencedKeys());
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(IMG_PREFIX) && !used.has(k.slice(IMG_PREFIX.length))) localStorage.removeItem(k);
    }
  } catch {
    // 忽略
  }

  /** 存设置；返回 false 表示本机存不下（这次打开仍然有效） */
  function persist(): boolean {
    return tryWrite(KEY, JSON.stringify(s));
  }

  /** 存一张图，返回 key 和是否存进了本机 */
  function putImage(dataUrl: string): { key: string; saved: boolean } {
    const key = uid('img');
    images[key] = dataUrl;
    return { key, saved: tryWrite(IMG_PREFIX + key, dataUrl) };
  }

  /** 没有任何地方再用这张图时删掉 */
  function dropImage(key: string | null | undefined) {
    if (!key || referencedKeys().includes(key)) return;
    delete images[key];
    try {
      localStorage.removeItem(IMG_PREFIX + key);
    } catch {
      // 忽略
    }
  }

  function imageUrl(key: string | null | undefined): string | null {
    return key ? (images[key] ?? null) : null;
  }

  // —— 配色 ——
  const paletteId = computed<PaletteId>(() => (app.resolvedTheme === 'dark' ? s.nightPalette : s.dayPalette));
  const paletteAccent = computed(() => seedsOf(paletteId.value, app.resolvedTheme).accent);

  function setPalette(id: PaletteId, which: 'both' | 'day' | 'night' = 'both') {
    if (which !== 'night') s.dayPalette = id;
    if (which !== 'day') s.nightPalette = id;
    persist();
  }
  function setSplit(on: boolean) {
    s.splitPalettes = on;
    if (!on) s.nightPalette = s.dayPalette;
    persist();
  }
  function setAccentFrom(v: Stored['accentFrom']) {
    s.accentFrom = v;
    persist();
  }

  // 把配色变量注入到 <html>：默认配色不注入，用 tokens.css
  const root = document.documentElement;
  let injected: string[] = [];
  watch(
    [paletteId, () => app.resolvedTheme],
    ([id, mode]) => {
      for (const k of injected) root.style.removeProperty(k);
      const vars = paletteVars(id, mode);
      injected = vars ? Object.keys(vars) : [];
      if (vars) for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', seedsOf(id, mode).bg);
    },
    { immediate: true },
  );

  // —— 聊天背景 ——
  /** 某个聊天实际用的背景（单独设的 → 通用的） */
  function backgroundOf(chatId?: string | null): ChatBackground | null {
    if (chatId && s.chatBackgrounds[chatId]) return s.chatBackgrounds[chatId] ?? null;
    return s.chatBackground;
  }
  function hasOwnBackground(chatId: string) {
    return !!s.chatBackgrounds[chatId];
  }

  /** scope：'global' 或某个 chatId */
  async function pickBackground(scope: string, file: Blob): Promise<boolean> {
    const dataUrl = await compressImage(file, { max: 1440 });
    const { key, saved } = putImage(dataUrl);
    const prev = scope === 'global' ? s.chatBackground : s.chatBackgrounds[scope];
    const next: ChatBackground = { ...DEFAULT_BACKGROUND, ...(prev ? { dim: prev.dim, blur: prev.blur } : {}), assetKey: key };
    if (scope === 'global') s.chatBackground = next;
    else s.chatBackgrounds[scope] = next;
    dropImage(prev?.assetKey);
    return persist() && saved;
  }

  /** 调遮罩 / 模糊。在单个聊天里调、而它原本跟随通用背景时，就给它单独存一份 */
  function tuneBackground(scope: string, patch: Partial<Pick<ChatBackground, 'dim' | 'blur'>>) {
    if (scope === 'global') {
      if (s.chatBackground) Object.assign(s.chatBackground, patch);
    } else {
      const own = s.chatBackgrounds[scope];
      if (own) Object.assign(own, patch);
      else if (s.chatBackground) s.chatBackgrounds[scope] = { ...s.chatBackground, ...patch };
    }
    persist();
  }

  /** 不用背景图：通用的直接清掉；单个聊天记成"这个聊天不用图" */
  function clearBackground(scope: string) {
    const prev = scope === 'global' ? s.chatBackground : s.chatBackgrounds[scope];
    if (scope === 'global') s.chatBackground = null;
    else s.chatBackgrounds[scope] = { ...DEFAULT_BACKGROUND, assetKey: null };
    dropImage(prev?.assetKey);
    persist();
  }

  /** 单个聊天恢复成跟随通用背景 */
  function resetBackground(chatId: string) {
    const prev = s.chatBackgrounds[chatId];
    delete s.chatBackgrounds[chatId];
    dropImage(prev?.assetKey);
    persist();
  }

  // —— 头像 ——
  function avatarKey(owner: AvatarOwner, id: string): string | null {
    return s.avatars[`${owner}:${id}`] ?? null;
  }
  async function pickAvatar(owner: AvatarOwner, id: string, file: Blob): Promise<boolean> {
    const dataUrl = await compressImage(file, { max: 320, square: true, quality: 0.86 });
    const { key, saved } = putImage(dataUrl);
    const prev = s.avatars[`${owner}:${id}`];
    s.avatars[`${owner}:${id}`] = key;
    dropImage(prev);
    return persist() && saved;
  }
  function resetAvatar(owner: AvatarOwner, id: string) {
    const prev = s.avatars[`${owner}:${id}`];
    delete s.avatars[`${owner}:${id}`];
    dropImage(prev);
    persist();
  }

  return {
    settings: s,
    paletteId,
    paletteAccent,
    setPalette,
    setSplit,
    setAccentFrom,
    imageUrl,
    backgroundOf,
    hasOwnBackground,
    pickBackground,
    tuneBackground,
    clearBackground,
    resetBackground,
    avatarKey,
    pickAvatar,
    resetAvatar,
  };
});
