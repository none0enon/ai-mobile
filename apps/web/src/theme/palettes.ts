import { mix, rgba, type ThemeName } from '@/utils/color';

/**
 * 配色（参考 math-reader 的"主题设置"）：每套都有白天、夜里两版。
 * 每版只写几种基础色，其余界面变量（毛玻璃、遮罩、地图……）按规则算出来。
 * 默认的"暮紫"就是 tokens.css 里的颜色：选它时不注入任何变量，直接用样式表。
 */
export type PaletteId = 'dusk' | 'ink' | 'blue' | 'green' | 'orange' | 'pink';

export interface PaletteSeeds {
  /** 页面底色 */
  bg: string;
  /** 卡片 */
  surface: string;
  /** 输入框、次级按钮 */
  panel: string;
  panel2?: string;
  border: string;
  ink: string;
  ink2: string;
  ink3: string;
  /** "点缀色跟随配色"时用的点缀色 */
  accent: string;
}

export interface Palette {
  id: PaletteId;
  name: string;
  day: PaletteSeeds;
  night: PaletteSeeds;
}

export const PALETTES: Palette[] = [
  {
    id: 'dusk',
    name: '暮紫',
    day: { bg: '#f6f2f7', surface: '#ffffff', panel: '#f2ecf6', panel2: '#e8dfef', border: '#e3d9ea', ink: '#251b2e', ink2: '#625775', ink3: '#978ca6', accent: '#f5b8a6' },
    night: { bg: '#0c0815', surface: '#191127', panel: '#241b35', panel2: '#2e2444', border: '#31274a', ink: '#f4edff', ink2: '#b9adce', ink3: '#82779a', accent: '#f5b8a6' },
  },
  {
    id: 'ink',
    name: '素墨',
    day: { bg: '#f4f4f2', surface: '#ffffff', panel: '#eeeeec', border: '#e0e0dd', ink: '#1c1c1c', ink2: '#5c5c5c', ink3: '#969696', accent: '#3a3a3a' },
    night: { bg: '#0e0e0e', surface: '#181818', panel: '#232323', border: '#303030', ink: '#ececec', ink2: '#a8a8a8', ink3: '#717171', accent: '#e2e2e2' },
  },
  {
    id: 'blue',
    name: '蓝调',
    day: { bg: '#eef3f8', surface: '#ffffff', panel: '#e5edf5', border: '#d2dfeb', ink: '#17263a', ink2: '#4a6585', ink3: '#8199b5', accent: '#3b7ddd' },
    night: { bg: '#0b1220', surface: '#121c30', panel: '#1a2842', panel2: '#223352', border: '#263a5c', ink: '#d6e2f7', ink2: '#8fa7cc', ink3: '#5f779f', accent: '#69a8f7' },
  },
  {
    id: 'green',
    name: '森绿',
    day: { bg: '#eef5f0', surface: '#ffffff', panel: '#e3eee6', border: '#cfe2d5', ink: '#17311f', ink2: '#47705a', ink3: '#80a48c', accent: '#2f9e5f' },
    night: { bg: '#0a140f', surface: '#111f18', panel: '#192d22', panel2: '#21392c', border: '#264434', ink: '#d3eadb', ink2: '#8dbb9e', ink3: '#5e8a6e', accent: '#5bd18b' },
  },
  {
    id: 'orange',
    name: '暖橙',
    day: { bg: '#faf5ef', surface: '#fffdf9', panel: '#f3ebe1', border: '#e8dccc', ink: '#3a2c18', ink2: '#7a6a52', ink3: '#a8987f', accent: '#e8792e' },
    night: { bg: '#130e0a', surface: '#1e1712', panel: '#2a2119', panel2: '#352a20', border: '#3f3124', ink: '#efe0cf', ink2: '#b9a07f', ink3: '#86705a', accent: '#f99a52' },
  },
  {
    id: 'pink',
    name: '樱粉',
    day: { bg: '#fff3f6', surface: '#ffffff', panel: '#fde7ee', border: '#f5d3df', ink: '#3a1a2a', ink2: '#8a4d6a', ink3: '#b5859c', accent: '#e8659b' },
    night: { bg: '#140b10', surface: '#20131a', panel: '#2c1b24', panel2: '#38232e', border: '#462a38', ink: '#f3d9e5', ink2: '#c08aa4', ink3: '#8f6077', accent: '#f283b4' },
  },
];

export const DEFAULT_PALETTE: PaletteId = 'dusk';

export function getPalette(id: string | null | undefined): Palette {
  return PALETTES.find((p) => p.id === id) ?? (PALETTES[0] as Palette);
}

export function seedsOf(id: string | null | undefined, mode: ThemeName): PaletteSeeds {
  const p = getPalette(id);
  return mode === 'dark' ? p.night : p.day;
}

function darkVars(s: PaletteSeeds): Record<string, string> {
  return {
    '--bg': s.bg,
    '--bg-2': mix(s.bg, s.surface, 0.5),
    '--surface': s.surface,
    '--panel': s.panel,
    '--panel-2': s.panel2 ?? mix(s.panel, s.border, 0.5),
    '--border': s.border,
    '--ink': s.ink,
    '--ink-2': s.ink2,
    '--ink-3': s.ink3,
    '--frame': mix(s.bg, '#000000', 0.5),
    '--glass': rgba(s.surface, 0.74),
    '--glass-strong': rgba(mix(s.bg, s.surface, 0.4), 0.92),
    '--glass-line': 'rgba(255, 255, 255, 0.09)',
    '--scrim': rgba(mix(s.bg, '#000000', 0.5), 0.6),
    '--bubble-ai': mix(s.surface, s.panel, 0.6),
    '--map-land': mix(s.bg, s.surface, 0.75),
    '--map-block': mix(s.surface, s.panel, 0.7),
    '--map-road': s.border,
    '--map-water': mix(s.surface, '#3b82c4', 0.28),
    '--map-park': mix(s.surface, '#3aa676', 0.24),
    '--map-home': mix(s.surface, s.accent, 0.14),
    '--map-campus': mix(s.surface, '#5470d6', 0.18),
  };
}

function lightVars(s: PaletteSeeds): Record<string, string> {
  return {
    '--bg': s.bg,
    '--bg-2': mix(s.bg, s.panel, 0.6),
    '--surface': s.surface,
    '--panel': s.panel,
    '--panel-2': s.panel2 ?? mix(s.panel, s.border, 0.6),
    '--border': s.border,
    '--ink': s.ink,
    '--ink-2': s.ink2,
    '--ink-3': s.ink3,
    '--frame': mix(s.bg, s.border, 0.7),
    '--glass': rgba(s.surface, 0.8),
    '--glass-strong': rgba(s.surface, 0.95),
    '--glass-line': rgba(s.ink, 0.09),
    '--scrim': rgba(s.ink, 0.38),
    '--bubble-ai': s.surface,
    '--map-land': mix(s.bg, s.panel, 0.5),
    '--map-block': mix(s.panel, s.border, 0.7),
    '--map-road': s.surface,
    '--map-water': mix(s.surface, '#6aaee8', 0.32),
    '--map-park': mix(s.surface, '#5cc490', 0.26),
    '--map-home': mix(s.surface, s.accent, 0.16),
    '--map-campus': mix(s.surface, '#7b98e8', 0.22),
  };
}

/** 这套配色在这个模式下要注入到 <html> 的变量；默认配色返回 null（用 tokens.css） */
export function paletteVars(id: string | null | undefined, mode: ThemeName): Record<string, string> | null {
  const p = getPalette(id);
  if (p.id === DEFAULT_PALETTE) return null;
  return mode === 'dark' ? darkVars(p.night) : lightVars(p.day);
}
