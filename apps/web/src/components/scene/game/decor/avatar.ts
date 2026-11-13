import { parseColor } from './model';

/**
 * 捏人：Q 版小人的样子（不碰 three.js：编辑器、存档、给模型的选项都在这里）。
 * 每一项都是从固定的几种里挑，颜色是 #rrggbb；她自己捏、帮你捏时按这些选项写 JSON。
 */
export interface Avatar {
  skin: string;
  hair: string;
  hairColor: string;
  bangs: string;
  eyes: string;
  eyeColor: string;
  mouth: string;
  blush: boolean;
  top: string;
  topColor: string;
  bottom: string;
  bottomColor: string;
  shoesColor: string;
  acc: string;
  accColor: string;
  /** 头的大小、身高：0.85–1.15 */
  head: number;
  height: number;
}

export interface Option {
  id: string;
  name: string;
}

export const HAIR_STYLES: Option[] = [
  { id: 'short', name: '短发' },
  { id: 'bob', name: '波波头' },
  { id: 'long', name: '长直发' },
  { id: 'twin', name: '双马尾' },
  { id: 'pony', name: '高马尾' },
  { id: 'bun', name: '丸子头' },
  { id: 'spiky', name: '刺猬头' },
];
export const BANGS: Option[] = [
  { id: 'straight', name: '齐刘海' },
  { id: 'side', name: '斜刘海' },
  { id: 'parted', name: '中分' },
  { id: 'none', name: '露额头' },
];
export const EYES: Option[] = [
  { id: 'round', name: '圆眼' },
  { id: 'sparkle', name: '亮晶晶' },
  { id: 'smile', name: '笑眼' },
  { id: 'sleepy', name: '困困眼' },
  { id: 'cat', name: '猫眼' },
];
export const MOUTHS: Option[] = [
  { id: 'smile', name: '微笑' },
  { id: 'open', name: '张嘴笑' },
  { id: 'cat', name: '猫猫嘴' },
  { id: 'o', name: '小圆嘴' },
  { id: 'flat', name: '一字嘴' },
];
export const TOPS: Option[] = [
  { id: 'tee', name: 'T 恤' },
  { id: 'hoodie', name: '卫衣' },
  { id: 'shirt', name: '衬衫' },
  { id: 'sweater', name: '毛衣' },
  { id: 'dress', name: '连衣裙' },
];
export const BOTTOMS: Option[] = [
  { id: 'pants', name: '长裤' },
  { id: 'shorts', name: '短裤' },
  { id: 'skirt', name: '短裙' },
];
export const ACCESSORIES: Option[] = [
  { id: 'none', name: '不戴' },
  { id: 'catEars', name: '猫耳' },
  { id: 'glasses', name: '眼镜' },
  { id: 'bow', name: '蝴蝶结' },
  { id: 'beanie', name: '毛线帽' },
  { id: 'headphones', name: '耳机' },
  { id: 'flower', name: '小花' },
];

export const SKINS: { name: string; hex: string }[] = [
  { name: '白皙', hex: '#fde6d8' },
  { name: '自然', hex: '#f6d2b8' },
  { name: '小麦', hex: '#e2b48f' },
  { name: '蜜色', hex: '#c98e66' },
  { name: '深棕', hex: '#94603f' },
];
export const HAIR_COLORS: { name: string; hex: string }[] = [
  { name: '黑', hex: '#2b2730' },
  { name: '深棕', hex: '#5a3d2e' },
  { name: '栗色', hex: '#8a5236' },
  { name: '亚麻', hex: '#c9a074' },
  { name: '金', hex: '#ecd08a' },
  { name: '银白', hex: '#e3e3ea' },
  { name: '粉', hex: '#f2a7bf' },
  { name: '雾蓝', hex: '#8fa9d6' },
  { name: '薰衣草', hex: '#b39ddb' },
  { name: '酒红', hex: '#8e3b4b' },
];
export const EYE_COLORS: { name: string; hex: string }[] = [
  { name: '黑', hex: '#2d2a33' },
  { name: '棕', hex: '#7a4a2f' },
  { name: '琥珀', hex: '#d39a3a' },
  { name: '蓝', hex: '#4f86c6' },
  { name: '绿', hex: '#4f9a6f' },
  { name: '紫', hex: '#8b62c2' },
  { name: '红', hex: '#c24a5a' },
];
export const CLOTH_COLORS: { name: string; hex: string }[] = [
  { name: '白', hex: '#f7f6f2' },
  { name: '奶油', hex: '#f3e9d2' },
  { name: '樱花粉', hex: '#f4b6c2' },
  { name: '珊瑚', hex: '#ee8f7a' },
  { name: '鹅黄', hex: '#f6e09a' },
  { name: '薄荷', hex: '#b5dfc9' },
  { name: '雾蓝', hex: '#a9c4e0' },
  { name: '牛仔蓝', hex: '#5b7fae' },
  { name: '薰衣草', hex: '#c9b8e8' },
  { name: '墨绿', hex: '#4f7a5e' },
  { name: '焦糖', hex: '#c98a4b' },
  { name: '炭灰', hex: '#5b5e66' },
  { name: '黑', hex: '#2f2e35' },
  { name: '酒红', hex: '#9c3d4f' },
];

export const DEFAULT_AVATAR: Avatar = {
  skin: '#f6d2b8',
  hair: 'short',
  hairColor: '#5a3d2e',
  bangs: 'straight',
  eyes: 'round',
  eyeColor: '#2d2a33',
  mouth: 'smile',
  blush: true,
  top: 'hoodie',
  topColor: '#a9c4e0',
  bottom: 'pants',
  bottomColor: '#5b7fae',
  shoesColor: '#f7f6f2',
  acc: 'none',
  accColor: '#f4b6c2',
  head: 1,
  height: 1,
};

/** 编辑器里一项一项列出来 */
export const AVATAR_FIELDS: { key: keyof Avatar; label: string; options?: Option[]; colors?: { name: string; hex: string }[]; group: 'face' | 'hair' | 'clothes' | 'more' }[] = [
  { key: 'skin', label: '肤色', colors: SKINS, group: 'face' },
  { key: 'eyes', label: '眼睛', options: EYES, group: 'face' },
  { key: 'eyeColor', label: '瞳色', colors: EYE_COLORS, group: 'face' },
  { key: 'mouth', label: '嘴巴', options: MOUTHS, group: 'face' },
  { key: 'hair', label: '发型', options: HAIR_STYLES, group: 'hair' },
  { key: 'bangs', label: '刘海', options: BANGS, group: 'hair' },
  { key: 'hairColor', label: '发色', colors: HAIR_COLORS, group: 'hair' },
  { key: 'top', label: '上衣', options: TOPS, group: 'clothes' },
  { key: 'topColor', label: '上衣颜色', colors: CLOTH_COLORS, group: 'clothes' },
  { key: 'bottom', label: '下装', options: BOTTOMS, group: 'clothes' },
  { key: 'bottomColor', label: '下装颜色', colors: CLOTH_COLORS, group: 'clothes' },
  { key: 'shoesColor', label: '鞋子', colors: CLOTH_COLORS, group: 'clothes' },
  { key: 'acc', label: '配饰', options: ACCESSORIES, group: 'more' },
  { key: 'accColor', label: '配饰颜色', colors: CLOTH_COLORS, group: 'more' },
];

const OPTION_LISTS: Partial<Record<keyof Avatar, Option[]>> = Object.fromEntries(AVATAR_FIELDS.filter((f) => f.options).map((f) => [f.key, f.options!]));
const COLOR_LISTS: Partial<Record<keyof Avatar, { name: string; hex: string }[]>> = Object.fromEntries(AVATAR_FIELDS.filter((f) => f.colors).map((f) => [f.key, f.colors!]));

function pickRandom<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** 按一个字符串（角色 id）定一个稳定的初始样子：没捏过时她也不会每次都变 */
export function seededAvatar(seed: string): Avatar {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const r = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const from = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  return {
    ...DEFAULT_AVATAR,
    hair: from(['long', 'bob', 'twin', 'pony', 'bun']),
    hairColor: from(HAIR_COLORS).hex,
    bangs: from(BANGS).id,
    eyes: from(['round', 'sparkle', 'cat']),
    eyeColor: from(EYE_COLORS).hex,
    mouth: from(['smile', 'cat', 'smile']),
    top: from(['tee', 'sweater', 'dress', 'shirt']),
    topColor: from(CLOTH_COLORS).hex,
    bottom: from(BOTTOMS).id,
    bottomColor: from(CLOTH_COLORS).hex,
    acc: from(['none', 'bow', 'flower', 'catEars']),
    accColor: from(CLOTH_COLORS).hex,
  };
}

export function randomAvatar(base: Avatar): Avatar {
  return {
    ...base,
    hair: pickRandom(HAIR_STYLES).id,
    hairColor: pickRandom(HAIR_COLORS).hex,
    bangs: pickRandom(BANGS).id,
    eyes: pickRandom(EYES).id,
    eyeColor: pickRandom(EYE_COLORS).hex,
    mouth: pickRandom(MOUTHS).id,
    blush: Math.random() < 0.7,
    top: pickRandom(TOPS).id,
    topColor: pickRandom(CLOTH_COLORS).hex,
    bottom: pickRandom(BOTTOMS).id,
    bottomColor: pickRandom(CLOTH_COLORS).hex,
    shoesColor: pickRandom(CLOTH_COLORS).hex,
    acc: pickRandom(ACCESSORIES).id,
    accColor: pickRandom(CLOTH_COLORS).hex,
  };
}

/**
 * 读存档、读模型写的 JSON：选项认 id 也认中文名，颜色认 #rrggbb 也认列表里的颜色名；认不出的用 base 的。
 */
export function parseAvatar(v: unknown, base: Avatar = DEFAULT_AVATAR): Avatar {
  if (!v || typeof v !== 'object') return { ...base };
  const o = v as Record<string, unknown>;
  const out: Avatar = { ...base };
  for (const [key, list] of Object.entries(OPTION_LISTS) as [keyof Avatar, Option[]][]) {
    const raw = String(o[key] ?? '').trim();
    const hit = list.find((x) => x.id === raw || x.name === raw) ?? (raw ? list.find((x) => raw.includes(x.name)) : undefined);
    if (hit) (out as unknown as Record<string, unknown>)[key] = hit.id;
  }
  for (const [key, list] of Object.entries(COLOR_LISTS) as [keyof Avatar, { name: string; hex: string }[]][]) {
    const raw = o[key];
    const named = typeof raw === 'string' ? list.find((c) => c.name === raw.trim()) : undefined;
    const hex = named?.hex ?? parseColor(raw);
    if (hex) (out as unknown as Record<string, unknown>)[key] = hex;
  }
  if (typeof o.blush === 'boolean') out.blush = o.blush;
  for (const key of ['head', 'height'] as const) {
    const n = Number(o[key]);
    if (Number.isFinite(n) && o[key] !== undefined && o[key] !== null && o[key] !== '') out[key] = Math.min(1.15, Math.max(0.85, n));
  }
  return out;
}

/** 给模型挑的选项 */
export function describeAvatarOptions(): string {
  const opts = AVATAR_FIELDS.map((f) => `${f.key}（${f.label}）：${f.options ? f.options.map((o) => `${o.id}=${o.name}`).join('、') : `${f.colors!.map((c) => c.name).join('、')}，也可以写 #rrggbb`}`);
  return [...opts, 'blush（腮红）：true / false', 'head（头的大小）、height（身高）：0.85–1.15，1 是标准'].join('\n');
}

const nameIn = (list: Option[] | undefined, id: string) => list?.find((o) => o.id === id)?.name ?? id;
const colorIn = (list: { name: string; hex: string }[] | undefined, hex: string) => list?.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;

/** 一句话说这个小人什么样（存进聊天、给模型看） */
export function describeAvatar(a: Avatar): string {
  const acc = a.acc === 'none' ? '' : `，戴着${colorIn(COLOR_LISTS.accColor, a.accColor)}${nameIn(OPTION_LISTS.acc, a.acc)}`;
  const bottom = a.top === 'dress' ? '' : `、${colorIn(COLOR_LISTS.bottomColor, a.bottomColor)}${nameIn(OPTION_LISTS.bottom, a.bottom)}`;
  return `${colorIn(COLOR_LISTS.hairColor, a.hairColor)}色${nameIn(OPTION_LISTS.hair, a.hair)}（${nameIn(OPTION_LISTS.bangs, a.bangs)}），${colorIn(COLOR_LISTS.eyeColor, a.eyeColor)}色眼睛（${nameIn(OPTION_LISTS.eyes, a.eyes)}），穿${colorIn(COLOR_LISTS.topColor, a.topColor)}${nameIn(OPTION_LISTS.top, a.top)}${bottom}${acc}`;
}
