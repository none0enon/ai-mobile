import { defineConfig, presetIcons, presetWind3, transformerDirectives, transformerVariantGroup } from 'unocss';

/**
 * 颜色全部指向 CSS 变量（src/styles/tokens.css），深浅主题和"角色点缀色"只改变量，不改类名。
 * 因为是变量色，不使用 bg-accent/20 这类透明度写法，改用 --accent-soft 等派生变量。
 */
export default defineConfig({
  content: {
    pipeline: {
      // 共享包里的场景注册表也写了图标类名，一起扫描
      include: [/\.(vue|ts|html)($|\?)/],
    },
  },
  presets: [
    presetWind3(),
    presetIcons({
      scale: 1.15,
      extraProperties: { display: 'inline-block', 'vertical-align': 'middle', 'flex-shrink': '0' },
    }),
  ],
  transformers: [transformerDirectives(), transformerVariantGroup()],
  theme: {
    colors: {
      bg: 'var(--bg)',
      bg2: 'var(--bg-2)',
      surface: 'var(--surface)',
      panel: 'var(--panel)',
      line: 'var(--border)',
      ink: { DEFAULT: 'var(--ink)', 2: 'var(--ink-2)', 3: 'var(--ink-3)' },
      accent: { DEFAULT: 'var(--accent)', ink: 'var(--accent-ink)', soft: 'var(--accent-soft)', line: 'var(--accent-line)' },
      good: 'var(--good)',
      warn: 'var(--warn)',
      bad: 'var(--bad)',
    },
    fontFamily: {
      sans: 'var(--font-sans)',
      serif: 'var(--font-serif)',
      num: 'var(--font-num)',
    },
  },
  shortcuts: {
    glass: 'bg-[var(--glass)] backdrop-blur-xl border border-[var(--glass-line)]',
    card: 'bg-surface border border-line rounded-[var(--radius)]',
    'icon-btn':
      'inline-flex items-center justify-center w-10 h-10 rounded-full text-ink transition-transform duration-150 active:scale-92 focus-visible:outline-2 focus-visible:outline-accent',
    chip: 'inline-flex items-center gap-1 px-2.5 h-7 rounded-full text-[12px] bg-panel text-ink-2 whitespace-nowrap',
    'press': 'transition-transform duration-150 active:scale-97',
  },
});
