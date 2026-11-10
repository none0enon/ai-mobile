<script setup lang="ts">
import { computed } from 'vue';
import { useAppStore } from '@/stores/app';
import { accentPalette } from '@/utils/color';

/**
 * 把一个角色的点缀色注入到这一块界面里（含 Vant 主色）。
 * 派生色在 JS 里算好，避免依赖 CSS color-mix 和"变量在声明处求值"的继承问题。
 */
const props = withDefaults(defineProps<{ accent?: string | null; tag?: string }>(), { accent: null, tag: 'div' });
const app = useAppStore();
const style = computed(() => (props.accent ? accentPalette(props.accent, app.resolvedTheme) : {}));
</script>

<template>
  <component :is="tag" class="accent-scope" :style="style">
    <slot />
  </component>
</template>
