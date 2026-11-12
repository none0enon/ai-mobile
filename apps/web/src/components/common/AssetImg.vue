<script setup lang="ts">
import { ref, watch } from 'vue';
import { assetUrl } from '@/services';

/**
 * 本机素材库里的一张图（按 key 取出来），或者服务商给的链接。缩略图用：铺满盒子、裁掉多的部分。
 * 取不出来（本机清过数据）时显示一个占位图标。
 */
const props = defineProps<{ assetKey: string | null | undefined; url?: string; alt?: string }>();
const src = ref<string | null>(null);
const missing = ref(false);
let token = 0;
watch(
  () => [props.assetKey, props.url] as const,
  async ([key, url]) => {
    const mine = (token += 1);
    src.value = null;
    missing.value = false;
    const resolved = key ? (/^(?:https?:|data:|blob:)/.test(key) ? key : await assetUrl(key)) : (url ?? null);
    if (mine !== token) return;
    src.value = resolved;
    missing.value = !resolved;
  },
  { immediate: true },
);
</script>

<template>
  <img v-if="src" :src="src" :alt="alt ?? ''" class="asset-img" @error="missing = true" />
  <span v-else class="asset-missing" :aria-label="missing ? '图片找不到了' : '正在读取'"><span :class="missing ? 'i-lucide-image-off' : 'i-lucide-image'" /></span>
</template>

<style scoped>
.asset-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 20%;
}
.asset-missing {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  color: var(--ink-3);
  background: var(--panel);
}
</style>
