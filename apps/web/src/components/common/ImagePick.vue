<script setup lang="ts">
/**
 * 选一张图片的按钮：用 <label> 包住隐藏的文件框，iOS Safari 和安卓 WebView 都能直接弹出相册。
 * 选完把文件交给外面处理，同一张图可以重复选。
 */
const emit = defineEmits<{ (e: 'pick', file: File): void }>();
function onChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit('pick', file);
  input.value = '';
}
</script>

<template>
  <label class="image-pick">
    <slot />
    <input type="file" accept="image/*" class="sr-only" @change="onChange" />
  </label>
</template>

<style scoped>
.image-pick {
  cursor: pointer;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
