<script setup lang="ts">
import { showToast } from 'vant';
import { computed } from 'vue';
import ImagePick from '@/components/common/ImagePick.vue';
import Wallpaper from '@/components/common/Wallpaper.vue';
import { useAppearanceStore } from '@/stores/appearance';

/**
 * 聊天背景编辑：scope 为 'global'（所有聊天的通用背景）或某个 chatId（只改这个聊天）。
 * 预览里用当前配色画两个气泡，调遮罩和模糊时马上能看到效果。
 */
const props = defineProps<{ scope: string }>();
const looks = useAppearanceStore();
const isGlobal = computed(() => props.scope === 'global');
const bg = computed(() => looks.backgroundOf(isGlobal.value ? null : props.scope));
const own = computed(() => !isGlobal.value && looks.hasOwnBackground(props.scope));
const hasImage = computed(() => !!looks.imageUrl(bg.value?.assetKey));

const status = computed(() => {
  if (isGlobal.value) return hasImage.value ? '所有聊天默认用这张' : '没有背景图，用配色的底色';
  if (own.value) return hasImage.value ? '这个聊天单独用这张' : '这个聊天不用背景图';
  return hasImage.value ? '跟随通用背景（外观里设置）' : '跟随通用设置：没有背景图';
});

async function onPick(file: File) {
  try {
    const saved = await looks.pickBackground(props.scope, file);
    showToast(saved ? '背景换好了' : '换好了，但本机存储不够，下次打开会恢复原样');
  } catch {
    showToast('这张图读不出来，换一张试试');
  }
}
function tune(key: 'dim' | 'blur', v: number | number[]) {
  looks.tuneBackground(props.scope, { [key]: Array.isArray(v) ? (v[0] ?? 0) : v });
}
</script>

<template>
  <div class="wall-editor">
    <div class="wall-preview">
      <Wallpaper :background="bg" />
      <div class="relative grid gap-2 p-3">
        <span class="bubble ai">今天也辛苦了，早点休息～</span>
        <span class="bubble me">嗯，想你了</span>
      </div>
    </div>
    <div class="text-[12.5px] text-ink-3 mt-2">{{ status }}</div>
    <div class="flex flex-wrap gap-2 mt-2.5">
      <ImagePick class="act primary" @pick="onPick"><span class="i-lucide-image-plus" />从相册选一张</ImagePick>
      <button v-if="hasImage || own" class="act" @click="looks.clearBackground(scope)"><span class="i-lucide-image-off" />不用背景图</button>
      <button v-if="own" class="act" @click="looks.resetBackground(scope)"><span class="i-lucide-undo-2" />跟随通用</button>
    </div>
    <template v-if="hasImage && bg">
      <label class="field-label">遮罩 {{ bg.dim }}%<span class="text-ink-3"> · 越高气泡越清楚</span></label>
      <van-slider :model-value="bg.dim" :min="0" :max="80" :step="5" bar-height="4px" button-size="16px" @update:model-value="(v: number | number[]) => tune('dim', v)" />
      <label class="field-label !mt-4">模糊 {{ bg.blur }}px</label>
      <van-slider :model-value="bg.blur" :min="0" :max="20" :step="1" bar-height="4px" button-size="16px" @update:model-value="(v: number | number[]) => tune('blur', v)" />
    </template>
  </div>
</template>

<style scoped>
.wall-preview {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border-radius: 18px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.bubble {
  max-width: 78%;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.45;
}
.bubble.ai {
  justify-self: start;
  border-top-left-radius: 6px;
  background: var(--bubble-ai);
  border: 1px solid var(--border);
}
.bubble.me {
  justify-self: end;
  border-top-right-radius: 6px;
  background: var(--bubble-me);
  color: var(--on-bubble-me);
}
.act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13.5px;
  white-space: nowrap;
}
.act.primary {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
</style>
