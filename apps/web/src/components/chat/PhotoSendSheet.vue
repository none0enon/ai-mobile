<script setup lang="ts">
import { ref } from 'vue';

/**
 * 发照片之前看一眼：选了哪几张（可以去掉、再加）、要不要配一句话。点"发送"交给外面。
 */
const props = defineProps<{ photos: { id: string; url: string }[]; max: number; visionLive: boolean; visionReason: string; herName: string }>();
const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'remove', id: string): void;
  (e: 'add'): void;
  (e: 'camera'): void;
  (e: 'close'): void;
}>();
const text = ref('');
function send() {
  emit('send', text.value.trim());
  text.value = '';
}
</script>

<template>
  <div class="sheet" data-testid="photo-send">
    <div class="flex items-center gap-2">
      <div class="sheet-title flex-1">发给{{ herName }} · {{ photos.length }} 张</div>
      <button class="close" aria-label="不发了" @click="emit('close')"><span class="i-lucide-x" /></button>
    </div>
    <div class="thumbs hide-scrollbar">
      <div v-for="p in props.photos" :key="p.id" class="thumb">
        <img :src="p.url" alt="要发的照片" />
        <button class="rm" aria-label="去掉这张" @click="emit('remove', p.id)"><span class="i-lucide-x" /></button>
      </div>
      <button v-if="photos.length < max" class="thumb add" aria-label="从相册再选" @click="emit('add')"><span class="i-lucide-image-plus" /></button>
      <button v-if="photos.length < max" class="thumb add" aria-label="再拍一张" @click="emit('camera')"><span class="i-lucide-camera" /></button>
    </div>
    <input v-model="text" class="field" :placeholder="`说点什么（可以不写）`" aria-label="配一句话" enterkeyhint="send" @keydown.enter.prevent="send" />
    <p class="text-[12px] mt-2 leading-relaxed" :class="visionLive ? 'text-ink-3' : 'text-warn'">
      <template v-if="visionLive">发出去以后"识图"先看一遍照片，{{ herName }}照着看到的回你。照片压缩后只存在这台设备。</template>
      <template v-else>识图还没接通（{{ visionReason }}）：照片照样发，但{{ herName }}看不到内容。在 API 设置 → 识图 里接上能看图的模型。</template>
    </p>
    <van-button type="primary" round block class="!mt-3" :disabled="!photos.length" data-testid="photo-send-btn" @click="send">发送</van-button>
  </div>
</template>

<style scoped>
.sheet {
  padding: 16px 16px calc(16px + var(--safe-bottom));
}
.close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink-2);
}
.thumbs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  margin: 12px 0;
}
.thumb {
  position: relative;
  flex-shrink: 0;
  width: 84px;
  height: 84px;
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb.add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--border);
  color: var(--ink-3);
  font-size: 24px;
}
.rm {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 13px;
}
.field {
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
</style>
