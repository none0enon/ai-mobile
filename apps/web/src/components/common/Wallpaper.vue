<script setup lang="ts">
import type { ChatBackground } from '@app/shared';
import { computed } from 'vue';
import { useAppearanceStore } from '@/stores/appearance';

/** 聊天背景：图片 + 模糊 + 一层底色遮罩（让气泡在花哨的图上也看得清）。铺满父元素，不接收点击 */
const props = defineProps<{ background: ChatBackground | null }>();
const looks = useAppearanceStore();
const url = computed(() => looks.imageUrl(props.background?.assetKey));
</script>

<template>
  <div v-if="url && background" class="wallpaper" aria-hidden="true">
    <div
      class="wallpaper-img"
      :style="{
        backgroundImage: `url(${url})`,
        filter: background.blur ? `blur(${background.blur}px)` : undefined,
        transform: background.blur ? 'scale(1.08)' : undefined,
      }"
    />
    <div class="wallpaper-dim" :style="{ opacity: background.dim / 100 }" />
  </div>
</template>

<style scoped>
.wallpaper {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}
.wallpaper-img {
  position: absolute;
  inset: 0;
  background-position: center;
  background-size: cover;
}
.wallpaper-dim {
  position: absolute;
  inset: 0;
  background: var(--bg);
}
</style>
