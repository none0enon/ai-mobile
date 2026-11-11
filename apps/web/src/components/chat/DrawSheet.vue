<script setup lang="ts">
import { IMAGE_MODES, type Character, type ImageMode } from '@app/shared';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAiStore } from '@/stores/ai';
import { useLibraryStore } from '@/stores/library';

/**
 * 聊天 ＋ → 生成配图：不经过聊天模型，直接用"生图"预设写 tags（生图提示词）、再调生图 API 出图。
 * 选画什么（场景 / 全身像 / 脸部特写 / 只画背景），可以写一句想画的画面；
 * 下面写明这次用哪个预设、哪个模型、哪个生图 API，哪一步没接通就直接去设置。
 */
const props = defineProps<{ character: Character }>();
const emit = defineEmits<{ (e: 'draw', req: { mode: ImageMode; caption: string }): void; (e: 'close'): void }>();

const ai = useAiStore();
const lib = useLibraryStore();
const router = useRouter();

const mode = ref<ImageMode>('scene');
const caption = ref('');

const MODE_ICONS: Record<ImageMode, string> = {
  scene: 'i-lucide-image',
  portrait: 'i-lucide-person-standing',
  face: 'i-lucide-smile',
  background: 'i-lucide-mountain',
};
const hint = computed(() => {
  const n = props.character.name;
  return {
    scene: `一个具体的画面：写了就画写的；不写就按最近的聊天和${n}此刻在哪画`,
    portrait: `${n}的全身像：站姿或坐姿、衣服、表情，背景简单`,
    face: `${n}的脸部特写，像自拍`,
    background: `只画地方，不画人；不写就画${n}此刻在的地方`,
  }[mode.value];
});

const preset = computed(() => lib.presetForUse('image', props.character) ?? null);
const promptStatus = computed(() => ai.status('imagePrompt'));
const imageStatus = computed(() => ai.status('image'));
/** 写 tags 这一步能不能用：生图提示词接通了，也有生图预设 */
const writesTags = computed(() => promptStatus.value.live && !!preset.value);
/** 没有写 tags 这一步时，描述原样交给生图模型：这时必须写 */
const canDraw = computed(() => imageStatus.value.live && (writesTags.value || !!caption.value.trim()));

const promptLine = computed(() => {
  if (!preset.value) return { ok: false, text: '没有生图预设：描述会原样交给生图模型' };
  const s = promptStatus.value;
  if (!s.live) return { ok: false, text: `生图提示词没接通（${s.reason}）：描述会原样交给生图模型` };
  return { ok: true, text: `用「${preset.value.name}」预设 · ${ai.chatModelOf('imagePrompt') || '未选模型'}` };
});
const imageLine = computed(() => {
  const s = imageStatus.value;
  return s.live ? { ok: true, text: ai.apiLine('image', s.api) } : { ok: false, text: `还没接通：${s.reason}` };
});
const placeholder = computed(() => {
  if (!writesTags.value) return '会原样交给生图模型，建议直接写英文 tags，例如：upper body, rainy window, warm desk lamp, looking back';
  const p = props.character.pronoun;
  return {
    scene: `例如：雨夜的窗边，${p}抱着靠垫回头看，台灯暖光`,
    portrait: '补充想要的衣服、姿势、背景（可以不写）',
    face: '补充表情、角度、发饰（可以不写）',
    background: '补充地点、时间、天气（可以不写）',
  }[mode.value];
});

function draw() {
  if (!canDraw.value) return;
  emit('draw', { mode: mode.value, caption: caption.value });
  caption.value = '';
}
function go(to: string) {
  emit('close');
  void router.push(to);
}
</script>

<template>
  <div class="sheet" data-testid="draw-sheet">
    <div class="sheet-title">生成配图 · {{ character.name }}</div>
    <p class="text-[12.5px] text-ink-3 mt-1 mb-0 leading-relaxed">直接调用生图 API，不经过聊天模型。画好的图作为{{ character.pronoun }}发来的一张图放进聊天。</p>

    <div class="field-label">画什么</div>
    <div class="modes" role="radiogroup" aria-label="画什么">
      <button
        v-for="(label, m) in IMAGE_MODES"
        :key="m"
        type="button"
        role="radio"
        :aria-checked="mode === m"
        class="mode press"
        :class="{ on: mode === m }"
        :data-mode="m"
        @click="mode = m"
      >
        <span :class="MODE_ICONS[m]" class="mode-icon shrink-0" /><span class="truncate">{{ label }}</span>
      </button>
    </div>
    <p class="text-[12px] text-ink-3 mt-1.5 mb-0 leading-relaxed">{{ hint }}</p>

    <label class="field-label" for="draw-caption">想画的画面{{ writesTags ? '（可以不写）' : '' }}</label>
    <textarea id="draw-caption" v-model="caption" class="textarea" rows="3" :placeholder="placeholder" @keydown.enter.ctrl.prevent="draw" @keydown.enter.meta.prevent="draw" />

    <div class="steps">
      <div class="step" data-step="prompt">
        <span class="step-icon"><span class="i-lucide-pen-line" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-600">1 · 写 tags</div>
          <div class="step-line" :class="{ warn: !promptLine.ok }">{{ promptLine.text }}</div>
        </div>
        <button v-if="!preset" type="button" class="link" @click="go('/me/presets?cat=image')">去预设</button>
        <button v-else-if="!promptStatus.live" type="button" class="link" @click="go('/me/api?feature=imagePrompt')">去设置</button>
      </div>
      <div class="step" data-step="image">
        <span class="step-icon"><span class="i-lucide-image" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[13px] font-600">2 · 出图</div>
          <div class="step-line" :class="{ bad: !imageLine.ok }">{{ imageLine.text }}</div>
        </div>
        <button v-if="!imageStatus.live" type="button" class="link" @click="go('/me/api?feature=image')">去设置</button>
      </div>
    </div>

    <div class="flex gap-2.5 mt-4">
      <van-button round block @click="emit('close')">取消</van-button>
      <van-button v-if="imageStatus.live" round block type="primary" :disabled="!canDraw" data-testid="draw-go" @click="draw">开始画</van-button>
      <van-button v-else round block type="primary" @click="go('/me/api?feature=image')">去设置生图 API</van-button>
    </div>
  </div>
</template>

<style scoped>
.modes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.mode {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  height: 40px;
  padding: 0 10px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 14px;
  white-space: nowrap;
}
.mode.on {
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--accent-line);
}
/* 窄屏 + 系统大字体：图标让位给文字（同 Segmented） */
@media (max-width: 360px) {
  .mode-icon {
    display: none;
  }
}
.steps {
  display: grid;
  gap: 8px;
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
.step {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.step-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: var(--surface);
  color: var(--accent-ink);
}
.step-line {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-2);
  word-break: break-word;
}
.step-line.warn {
  color: var(--warn);
}
.step-line.bad {
  color: var(--bad);
}
.link {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--accent-ink);
}
</style>
