import { parseColor } from './model';

/**
 * 捏人：Q 版小人的样子（不碰 three.js：编辑器、存档、给模型的选项都在这里）。
 * 每一项都是从固定的几种里挑，颜色是 #rrggbb；她自己捏、帮你捏时按这些选项写 JSON。
 * - 头发：发型（后面和两边）、发顶、刘海各挑一种，能左右翻转，发梢能渐变成另一个颜色；
 * - 衣服：上衣 + 下装，或者穿一整件套装（连衣裙、浴衣、浴袍）；每一件除了颜色还能挑花纹；
 * - 配饰能戴好几样。
 */
export interface Avatar {
  skin: string;
  hair: string;
  /** 发顶 */
  hairTop: string;
  bangs: string;
  /** 头发左右翻转（斜刘海、遮眼刘海换一边） */
  hairFlip: boolean;
  hairColor: string;
  /** 发梢渐变成这个颜色；空着是不渐变 */
  hairColor2: string;
  eyes: string;
  eyeColor: string;
  mouth: string;
  blush: boolean;
  /** 套装：none 是不穿套装（穿上衣 + 下装） */
  suit: string;
  suitColor: string;
  /** 套装的腰带 / 点缀 */
  suitColor2: string;
  suitPattern: string;
  top: string;
  topColor: string;
  topPattern: string;
  bottom: string;
  bottomColor: string;
  bottomPattern: string;
  shoesColor: string;
  /** 配饰：能戴好几样 */
  acc: string[];
  accColor: string;
  /** 头的大小、身高：0.85–1.15 */
  head: number;
  height: number;
}

export interface Option {
  id: string;
  name: string;
}
export interface Swatch {
  name: string;
  hex: string;
}

export const HAIR_STYLES: Option[] = [
  { id: 'short', name: '短发' },
  { id: 'bob', name: '波波头' },
  { id: 'long', name: '长直发' },
  { id: 'wild', name: '炸长发' },
  { id: 'twin', name: '双马尾' },
  { id: 'pony', name: '高马尾' },
  { id: 'bun', name: '丸子头' },
  { id: 'spiky', name: '刺猬头' },
];
export const HAIR_TOPS: Option[] = [
  { id: 'flat', name: '服帖' },
  { id: 'fluffy', name: '蓬松' },
  { id: 'ahoge', name: '呆毛' },
  { id: 'spiky', name: '炸毛' },
  { id: 'messy', name: '凌乱' },
];
export const BANGS: Option[] = [
  { id: 'straight', name: '齐刘海' },
  { id: 'side', name: '斜刘海' },
  { id: 'parted', name: '中分' },
  { id: 'oneEye', name: '遮一只眼' },
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
export const SUITS: Option[] = [
  { id: 'none', name: '不穿套装' },
  { id: 'dress', name: '连衣裙' },
  { id: 'yukata', name: '浴衣' },
  { id: 'bathrobe', name: '浴袍' },
];
export const TOPS: Option[] = [
  { id: 'tee', name: 'T 恤' },
  { id: 'hoodie', name: '卫衣' },
  { id: 'shirt', name: '衬衫' },
  { id: 'sweater', name: '毛衣' },
];
export const BOTTOMS: Option[] = [
  { id: 'pants', name: '长裤' },
  { id: 'shorts', name: '短裤' },
  { id: 'skirt', name: '短裙' },
];
export const PATTERNS: Option[] = [
  { id: 'plain', name: '纯色' },
  { id: 'stripe', name: '条纹' },
  { id: 'dots', name: '波点' },
  { id: 'check', name: '格子' },
  { id: 'floral', name: '碎花' },
  { id: 'heart', name: '爱心' },
  { id: 'star', name: '星星' },
];
export const ACCESSORIES: Option[] = [
  { id: 'catEars', name: '猫耳' },
  { id: 'glasses', name: '眼镜' },
  { id: 'bow', name: '蝴蝶结' },
  { id: 'beanie', name: '毛线帽' },
  { id: 'headphones', name: '头戴耳机' },
  { id: 'neckphones', name: '挂脖耳机' },
  { id: 'gloves', name: '手套' },
  { id: 'flower', name: '小花' },
];

export const SKINS: Swatch[] = [
  { name: '白皙', hex: '#fde6d8' },
  { name: '自然', hex: '#f6d2b8' },
  { name: '小麦', hex: '#e2b48f' },
  { name: '蜜色', hex: '#c98e66' },
  { name: '深棕', hex: '#94603f' },
];
export const HAIR_COLORS: Swatch[] = [
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
export const EYE_COLORS: Swatch[] = [
  { name: '黑', hex: '#2d2a33' },
  { name: '棕', hex: '#7a4a2f' },
  { name: '琥珀', hex: '#d39a3a' },
  { name: '蓝', hex: '#4f86c6' },
  { name: '绿', hex: '#4f9a6f' },
  { name: '紫', hex: '#8b62c2' },
  { name: '红', hex: '#c24a5a' },
];
export const CLOTH_COLORS: Swatch[] = [
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
  hairTop: 'flat',
  bangs: 'straight',
  hairFlip: false,
  hairColor: '#5a3d2e',
  hairColor2: '',
  eyes: 'round',
  eyeColor: '#2d2a33',
  mouth: 'smile',
  blush: true,
  suit: 'none',
  suitColor: '#f4b6c2',
  suitColor2: '#f7f6f2',
  suitPattern: 'plain',
  top: 'hoodie',
  topColor: '#a9c4e0',
  topPattern: 'plain',
  bottom: 'pants',
  bottomColor: '#5b7fae',
  bottomPattern: 'plain',
  shoesColor: '#f7f6f2',
  acc: [],
  accColor: '#f4b6c2',
  head: 1,
  height: 1,
};

type Group = 'face' | 'hair' | 'clothes' | 'more';

/**
 * 编辑器里一项一项列出来。一项是这几种里的一种：
 * - options：几个里挑一个（multi 时能挑好几个）；
 * - colors：颜色（none 写了就多一个"不要"的选项，存成空字符串）；
 * - toggle：开 / 关（[开着叫什么, 关着叫什么]）。
 * when：这一项现在用不用得上（穿了套装就不用挑上衣下装）。
 */
export interface AvatarField {
  key: keyof Avatar;
  label: string;
  group: Group;
  options?: Option[];
  multi?: boolean;
  colors?: Swatch[];
  none?: string;
  toggle?: [string, string];
  when?: (a: Avatar) => boolean;
}

const suited = (a: Avatar) => a.suit !== 'none';
const unsuited = (a: Avatar) => a.suit === 'none';

export const AVATAR_FIELDS: AvatarField[] = [
  { key: 'skin', label: '肤色', colors: SKINS, group: 'face' },
  { key: 'eyes', label: '眼睛', options: EYES, group: 'face' },
  { key: 'eyeColor', label: '瞳色', colors: EYE_COLORS, group: 'face' },
  { key: 'mouth', label: '嘴巴', options: MOUTHS, group: 'face' },
  { key: 'blush', label: '腮红', toggle: ['有', '没有'], group: 'face' },
  { key: 'hair', label: '发型', options: HAIR_STYLES, group: 'hair' },
  { key: 'hairTop', label: '发顶', options: HAIR_TOPS, group: 'hair' },
  { key: 'bangs', label: '刘海', options: BANGS, group: 'hair' },
  { key: 'hairFlip', label: '左右翻转', toggle: ['翻过来', '不翻'], group: 'hair' },
  { key: 'hairColor', label: '发色', colors: HAIR_COLORS, group: 'hair' },
  { key: 'hairColor2', label: '发梢渐变', colors: HAIR_COLORS, none: '不渐变', group: 'hair' },
  { key: 'suit', label: '套装', options: SUITS, group: 'clothes' },
  { key: 'suitColor', label: '套装颜色', colors: CLOTH_COLORS, group: 'clothes', when: suited },
  { key: 'suitPattern', label: '套装花纹', options: PATTERNS, group: 'clothes', when: suited },
  { key: 'suitColor2', label: '腰带和点缀', colors: CLOTH_COLORS, group: 'clothes', when: suited },
  { key: 'top', label: '上衣', options: TOPS, group: 'clothes', when: unsuited },
  { key: 'topColor', label: '上衣颜色', colors: CLOTH_COLORS, group: 'clothes', when: unsuited },
  { key: 'topPattern', label: '上衣花纹', options: PATTERNS, group: 'clothes', when: unsuited },
  { key: 'bottom', label: '下装', options: BOTTOMS, group: 'clothes', when: unsuited },
  { key: 'bottomColor', label: '下装颜色', colors: CLOTH_COLORS, group: 'clothes', when: unsuited },
  { key: 'bottomPattern', label: '下装花纹', options: PATTERNS, group: 'clothes', when: unsuited },
  { key: 'shoesColor', label: '鞋子', colors: CLOTH_COLORS, group: 'clothes' },
  { key: 'acc', label: '配饰（可以多选）', options: ACCESSORIES, multi: true, group: 'more' },
  { key: 'accColor', label: '配饰颜色', colors: CLOTH_COLORS, group: 'more', when: (a) => a.acc.length > 0 },
];

const FIELD: Partial<Record<keyof Avatar, AvatarField>> = Object.fromEntries(AVATAR_FIELDS.map((f) => [f.key, f]));

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
  // 挑的顺序别动：同一个角色每次算出来要一样
  const hair = from(['long', 'bob', 'twin', 'pony', 'bun']);
  const hairColor = from(HAIR_COLORS).hex;
  const bangs = from(['straight', 'side', 'parted', 'none']);
  const eyes = from(['round', 'sparkle', 'cat']);
  const eyeColor = from(EYE_COLORS).hex;
  const mouth = from(['smile', 'cat', 'smile']);
  const top = from(['tee', 'sweater', 'dress', 'shirt']);
  const topColor = from(CLOTH_COLORS).hex;
  const bottom = from(BOTTOMS).id;
  const bottomColor = from(CLOTH_COLORS).hex;
  const acc = from(['none', 'bow', 'flower', 'catEars']);
  const accColor = from(CLOTH_COLORS).hex;
  return {
    ...DEFAULT_AVATAR,
    hair,
    hairColor,
    bangs,
    eyes,
    eyeColor,
    mouth,
    ...(top === 'dress' ? { suit: 'dress', suitColor: topColor, top: 'tee' } : { top }),
    topColor,
    bottom,
    bottomColor,
    acc: acc === 'none' ? [] : [acc],
    accColor,
  };
}

export function randomAvatar(base: Avatar): Avatar {
  const suit = Math.random() < 0.3 ? pickRandom(SUITS.slice(1)).id : 'none';
  // 花纹别太多：大多是纯色
  const pattern = () => (Math.random() < 0.3 ? pickRandom(PATTERNS.slice(1)).id : 'plain');
  const acc = ACCESSORIES.filter(() => Math.random() < 0.16).map((o) => o.id);
  return {
    ...base,
    hair: pickRandom(HAIR_STYLES).id,
    hairTop: Math.random() < 0.5 ? 'flat' : pickRandom(HAIR_TOPS).id,
    hairColor: pickRandom(HAIR_COLORS).hex,
    hairColor2: Math.random() < 0.2 ? pickRandom(HAIR_COLORS).hex : '',
    hairFlip: Math.random() < 0.5,
    bangs: pickRandom(BANGS).id,
    eyes: pickRandom(EYES).id,
    eyeColor: pickRandom(EYE_COLORS).hex,
    mouth: pickRandom(MOUTHS).id,
    blush: Math.random() < 0.7,
    suit,
    suitColor: pickRandom(CLOTH_COLORS).hex,
    suitColor2: pickRandom(CLOTH_COLORS).hex,
    suitPattern: pattern(),
    top: pickRandom(TOPS).id,
    topColor: pickRandom(CLOTH_COLORS).hex,
    topPattern: pattern(),
    bottom: pickRandom(BOTTOMS).id,
    bottomColor: pickRandom(CLOTH_COLORS).hex,
    bottomPattern: pattern(),
    shoesColor: pickRandom(CLOTH_COLORS).hex,
    acc,
    accColor: pickRandom(CLOTH_COLORS).hex,
  };
}

const findOption = (list: Option[], raw: string) => list.find((x) => x.id === raw || x.name === raw) ?? (raw ? list.find((x) => raw.includes(x.name)) : undefined);

/**
 * 读存档、读模型写的 JSON：选项认 id 也认中文名，颜色认 #rrggbb 也认列表里的颜色名；认不出的用 base 的。
 * 老存档：配饰是一个字符串（'none' 是不戴）、连衣裙在上衣里，这里一起换成现在的写法。
 */
export function parseAvatar(v: unknown, base: Avatar = DEFAULT_AVATAR): Avatar {
  if (!v || typeof v !== 'object') return { ...base, acc: [...base.acc] };
  const o = v as Record<string, unknown>;
  const out: Avatar = { ...base, acc: [...base.acc] };
  const bag = out as unknown as Record<string, unknown>;
  for (const f of AVATAR_FIELDS) {
    const raw = o[f.key];
    if (raw === undefined || raw === null) continue;
    if (f.options && f.multi) {
      const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,，、\s]+/);
      const ids = parts.map((p) => findOption(f.options!, p.trim())?.id).filter((id): id is string => !!id);
      bag[f.key] = [...new Set(ids)];
    } else if (f.options) {
      const hit = findOption(f.options, String(raw).trim());
      if (hit) bag[f.key] = hit.id;
    } else if (f.colors) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (f.none && (text === '' || text === f.none || text === 'none' || raw === false)) bag[f.key] = '';
      else {
        const hex = f.colors.find((c) => c.name === text)?.hex ?? parseColor(raw);
        if (hex) bag[f.key] = hex;
      }
    } else if (f.toggle) {
      if (typeof raw === 'boolean') bag[f.key] = raw;
      else if (raw === 'true' || raw === 'false') bag[f.key] = raw === 'true';
    }
  }
  // 老写法：上衣里的连衣裙
  if (String(o.top ?? '').trim() === 'dress' || String(o.top ?? '').includes('连衣裙')) {
    out.suit = 'dress';
    if (o.suitColor === undefined) out.suitColor = out.topColor;
  }
  for (const key of ['head', 'height'] as const) {
    const n = Number(o[key]);
    if (Number.isFinite(n) && o[key] !== undefined && o[key] !== null && o[key] !== '') out[key] = Math.min(1.15, Math.max(0.85, n));
  }
  return out;
}

/** 给模型挑的选项 */
export function describeAvatarOptions(): string {
  const opts = AVATAR_FIELDS.map((f) => {
    const label = f.label.replace(/（.*）$/, '');
    if (f.toggle) return `${f.key}（${label}）：true / false`;
    if (f.options) return `${f.key}（${label}${f.multi ? '，可以挑好几个，写成数组，不戴写 []' : ''}）：${f.options.map((o) => `${o.id}=${o.name}`).join('、')}`;
    return `${f.key}（${label}）：${f.colors!.map((c) => c.name).join('、')}，也可以写 #rrggbb${f.none ? `；${f.none}写 ""` : ''}`;
  });
  return [
    ...opts,
    'head（头的大小）、height（身高）：0.85–1.15，1 是标准',
    '穿套装时（suit 不是 none）不用写上衣和下装；不穿套装时 suit 写 none',
  ].join('\n');
}

const nameIn = (key: keyof Avatar, id: string) => FIELD[key]?.options?.find((o) => o.id === id)?.name ?? id;
const colorIn = (key: keyof Avatar, hex: string) => FIELD[key]?.colors?.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
const patternIn = (id: string) => (id === 'plain' ? '' : (PATTERNS.find((p) => p.id === id)?.name ?? ''));

/** 一句话说这个小人什么样（存进聊天、给模型看） */
export function describeAvatar(a: Avatar): string {
  const hair = `${colorIn('hairColor', a.hairColor)}色${a.hairColor2 ? `渐变${colorIn('hairColor2', a.hairColor2)}色` : ''}${nameIn('hair', a.hair)}（${nameIn('bangs', a.bangs)}${a.hairTop === 'flat' ? '' : `、${nameIn('hairTop', a.hairTop)}`}）`;
  const clothes =
    a.suit !== 'none'
      ? `${colorIn('suitColor', a.suitColor)}${patternIn(a.suitPattern)}${nameIn('suit', a.suit)}`
      : `${colorIn('topColor', a.topColor)}${patternIn(a.topPattern)}${nameIn('top', a.top)}、${colorIn('bottomColor', a.bottomColor)}${patternIn(a.bottomPattern)}${nameIn('bottom', a.bottom)}`;
  const acc = a.acc.length ? `，戴着${colorIn('accColor', a.accColor)}的${a.acc.map((id) => nameIn('acc', id)).join('、')}` : '';
  return `${hair}，${colorIn('eyeColor', a.eyeColor)}色眼睛（${nameIn('eyes', a.eyes)}），穿${clothes}${acc}`;
}
