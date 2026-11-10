<script setup lang="ts">
import type { Persona } from '@app/shared';
import { computed } from 'vue';
import { useAppearanceStore } from '@/stores/appearance';

/** 你的头像：上传过就用图片，没有就用名字的最后一个字 */
const props = withDefaults(defineProps<{ persona: Persona; size?: number }>(), { size: 44 });
const looks = useAppearanceStore();
const src = computed(() => looks.imageUrl(looks.avatarKey('persona', props.persona.id) ?? props.persona.avatar));
</script>

<template>
  <span class="persona-avatar" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` }" :title="persona.name">
    <img v-if="src" :src="src" alt="" />
    <template v-else>{{ persona.name.slice(-1) }}</template>
  </span>
</template>

<style scoped>
.persona-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
  background: linear-gradient(135deg, #8db8ff, #6f5b9e);
  color: #fff;
  font-weight: 700;
  flex-shrink: 0;
}
.persona-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
