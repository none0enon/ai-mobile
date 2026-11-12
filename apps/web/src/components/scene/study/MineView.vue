<script setup lang="ts">
import type { Persona } from '@app/shared';
import AssetImg from '@/components/common/AssetImg.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';

/**
 * 各自专注时下半屏"你这边"的画面：你预先上传的照片 / 按你的人设画的图 / 摄像头（后续实现）。
 * 还没设置、图找不到、摄像头还不能用时显示你的头像和一个"设置画面"的入口。点整块打开设置。
 */
defineProps<{
  source: 'photo' | 'persona' | 'camera' | null;
  photoKey: string | null;
  art: { assetKey: string | null; url?: string; title: string } | null;
  persona: Persona;
  /** 正在画你这边（"正在写 tags""正在画"） */
  drawing?: string | null;
}>();
defineEmits<{ (e: 'open'): void }>();
</script>

<template>
  <button type="button" class="mine" aria-label="你这边的画面：点一下换照片、按人设画或者以后接摄像头" @click="$emit('open')">
    <AssetImg v-if="source === 'photo' && photoKey" :asset-key="photoKey" alt="你上传的照片" class="mine-img" />
    <AssetImg v-else-if="source === 'persona' && art" :asset-key="art.assetKey" :url="art.url" :alt="art.title || `按${persona.name}的人设画的图`" class="mine-img" />
    <span v-else class="placeholder">
      <PersonaAvatar :persona="persona" :size="52" />
      <span class="text-[13px] text-ink-2 mt-2">
        <template v-if="drawing">{{ drawing }}</template>
        <template v-else-if="source === 'camera'">摄像头画面后续支持，先换成照片或按人设画</template>
        <template v-else>你这边 · 点一下放照片，或按你的人设画一张</template>
      </span>
      <span v-if="!drawing" class="set"><span class="i-lucide-image-plus" />设置画面</span>
    </span>
  </button>
</template>

<style scoped>
.mine {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  overflow: hidden;
  background:
    radial-gradient(120% 80% at 50% 100%, var(--accent-soft), transparent 70%),
    linear-gradient(180deg, var(--bg-2), var(--surface));
  cursor: pointer;
}
.mine .mine-img {
  position: absolute;
  inset: 0;
  object-position: 50% 35%;
}
.placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 90px 28px 80px;
  text-align: center;
}
.set {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 10px;
  height: 32px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent-ink);
  font-size: 13px;
}
</style>
