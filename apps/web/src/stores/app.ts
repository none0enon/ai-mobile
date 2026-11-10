import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ThemeName } from '@/utils/color';

export type ThemeSetting = 'system' | 'dark' | 'light';

const THEME_KEY = 'ai-mobile:theme';

function readThemeSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    // 无痕模式等情况下 localStorage 不可用
  }
  return 'system';
}

export interface Banner {
  id: number;
  characterId: string;
  title: string;
  text: string;
  /** 点横幅去哪 */
  to: string;
  icon?: string;
}

export const useAppStore = defineStore('app', () => {
  const root = document.documentElement;
  const themeSetting = ref<ThemeSetting>(readThemeSetting());
  /** 宿主页面（例如 Artifact 查看器）自己设的 data-theme，"跟随系统"时尊重它 */
  const hostTheme = ref<string | null>(root.getAttribute('data-theme'));
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const systemDark = ref(media ? media.matches : true);
  media?.addEventListener?.('change', (e) => {
    systemDark.value = e.matches;
  });

  new MutationObserver(() => {
    const v = root.getAttribute('data-theme');
    if (themeSetting.value === 'system') {
      hostTheme.value = v;
      return;
    }
    if (v !== themeSetting.value) {
      hostTheme.value = v;
      root.setAttribute('data-theme', themeSetting.value);
    }
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  const resolvedTheme = computed<ThemeName>(() => {
    if (themeSetting.value !== 'system') return themeSetting.value;
    if (hostTheme.value === 'dark' || hostTheme.value === 'light') return hostTheme.value;
    return systemDark.value ? 'dark' : 'light';
  });

  function applyTheme() {
    if (themeSetting.value === 'system') {
      if (hostTheme.value) root.setAttribute('data-theme', hostTheme.value);
      else root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', themeSetting.value);
    }
  }

  function setTheme(t: ThemeSetting) {
    themeSetting.value = t;
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // 忽略
    }
    applyTheme();
  }

  applyTheme();
  // 地址栏颜色（meta theme-color）跟着配色走，在 stores/appearance.ts 里设

  /** "一起"和"回忆"页当前陪着你的角色 */
  const activeCharacterId = ref('suwan');

  /** 应用内横幅：在别的页面时收到主动消息 / 来电 */
  const banner = ref<Banner | null>(null);
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  function showBanner(b: Omit<Banner, 'id'>, ms = 6000) {
    banner.value = { ...b, id: Date.now() };
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      banner.value = null;
    }, ms);
  }
  function dismissBanner() {
    banner.value = null;
  }

  return { themeSetting, resolvedTheme, setTheme, activeCharacterId, banner, showBanner, dismissBanner };
});
