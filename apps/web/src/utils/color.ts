/**
 * 角色点缀色的派生色在 JS 里算好，再以内联 CSS 变量注入（AccentScope）。
 * 不用 CSS color-mix()：国内一些厂商 WebView 停在 Chrome 111 以前，不支持。
 * 也顺带避开"自定义属性在声明处求值"的继承陷阱：子元素只改 --accent 不会让 :root 上派生的变量跟着变。
 */
type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

/** t = 0 返回 a，t = 1 返回 b */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 相对亮度 0-1 */
export function luminance(hex: string): number {
  const lin = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}

export type ThemeName = 'dark' | 'light';

/** 一个点缀色 → 一整套界面变量（含 Vant 的主色变量） */
export function accentPalette(accent: string, theme: ThemeName): Record<string, string> {
  const dark = theme === 'dark';
  const onAccent = luminance(accent) > 0.36 ? mix(accent, '#1b0c12', 0.86) : '#ffffff';
  const bubble = dark ? accent : mix(accent, '#ffffff', 0.2);
  return {
    '--accent': accent,
    '--accent-ink': dark ? mix(accent, '#ffffff', 0.15) : mix(accent, '#2a1018', 0.5),
    '--accent-soft': rgba(accent, dark ? 0.16 : 0.22),
    '--accent-line': rgba(accent, dark ? 0.42 : 0.55),
    '--accent-glow': rgba(accent, dark ? 0.35 : 0.3),
    '--on-accent': onAccent,
    '--bubble-me': bubble,
    '--on-bubble-me': onAccent,
    '--van-primary-color': accent,
    '--van-switch-on-background': accent,
    '--van-tabs-bottom-bar-color': accent,
    '--van-button-primary-background': accent,
    '--van-button-primary-border-color': accent,
    '--van-button-primary-color': onAccent,
    '--van-slider-active-background': accent,
    '--van-radio-checked-icon-color': accent,
    '--van-checkbox-checked-icon-color': accent,
    '--van-progress-color': accent,
    '--van-tag-primary-color': accent,
    '--van-stepper-button-round-theme-color': accent,
  };
}
