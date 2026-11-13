<script setup lang="ts">
import { errorText, isAbortError } from '@app/ai';
import type { Character } from '@app/shared';
import { showImagePreview, showToast } from 'vant';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import AssetImg from '@/components/common/AssetImg.vue';
import Segmented from '@/components/common/Segmented.vue';
import { services } from '@/services';
import { assetUrl } from '@/services/assets';
import { chapterLabel } from '@/services/workshop';
import type { IllustrateStage } from '@/services/types';
import { useAiStore } from '@/stores/ai';
import { useWorkshopStore, type Drawing } from '@/stores/workshop';

/**
 * 创意工坊 · 画画（设计文档 §9.11）：你写想画什么，生图提示词智能体按"创意工坊 · 画画"的生图预设（game-workshop-image）写成 tags，再调生图 API。
 * - 画她：长相由程序按角色加（预设里只发 ws-her 那一块）；
 * - 自由画：不加任何人的长相，画面里谁长什么样全按你写的（ws-free）；可以选一部小说当参考，把设定和最近一章的开头带给提示词智能体。
 * 画好的存进创意工坊的作品里，点"给她看"让她看。
 */
type Who = 'her' | 'free';
type Size = Drawing['size'];

const props = defineProps<{ character: Character }>();
const emit = defineEmits<{ back: []; show: [drawingId: string] }>();

const ws = useWorkshopStore();
const ai = useAiStore();
const router = useRouter();
const imageStatus = computed(() => ai.status('image'));

const caption = ref('');
const who = ref<Who>('free');
const size = ref<Size>('portrait');
const novelId = ref('');
const stage = ref<IllustrateStage | null>(null);
const result = ref<Drawing | null>(null);
const showPrompt = ref(false);
let abort: AbortController | null = null;
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  abort?.abort();
});

const WHO = computed(() => [
  { value: 'free' as Who, label: '自由画', icon: 'i-lucide-paintbrush' },
  { value: 'her' as Who, label: `画${props.character.name}`, icon: 'i-lucide-user-round' },
]);
const SIZES: { value: Size; label: string }[] = [
  { value: 'portrait', label: '竖图' },
  { value: 'square', label: '方图' },
  { value: 'landscape', label: '横图' },
];
const STAGE: Record<IllustrateStage, string> = { queued: '前面还有图在画，排队中', prompt: '在写生图提示词', image: '在画' };
const IDEAS = computed(() =>
  who.value === 'her'
    ? [`${props.character.name}穿着睡衣抱着枕头，窝在沙发上看电影`, `夏日祭，${props.character.name}穿浴衣提着金鱼回头笑`]
    : ['雨夜的旧书店，暖黄的灯光，一只猫睡在柜台上', '少女站在漂浮的岛屿边缘，远处是巨大的鲸鱼在云海里游'],
);

/** 选了参考的小说：设定、大纲和最近一章的开头带给提示词智能体（"最近的对话"那一块） */
function reference(): string[] {
  const n = ws.novelById(novelId.value);
  if (!n) return [];
  const last = n.chapters.at(-1);
  return [
    `参考：小说《${n.title}》${n.genre ? `（${n.genre}）` : ''}`,
    n.setting.trim() ? `设定和人物：${n.setting.trim().replace(/\s+/g, ' ').slice(0, 600)}` : '',
    n.style.trim() ? `文风：${n.style.trim()}` : '',
    last ? `最近一篇「${chapterLabel(n, last)}」的开头：${last.text.replace(/\s+/g, ' ').slice(0, 300)}` : '',
  ].filter(Boolean);
}

async function draw(text = caption.value) {
  const c = text.trim();
  if (!c || stage.value) return;
  if (!imageStatus.value.live) return showToast(`生图 API 还没接通：${imageStatus.value.reason}`);
  abort = new AbortController();
  stage.value = 'prompt';
  showPrompt.value = false;
  try {
    const out = await services.image.illustrate(
      {
        characterId: props.character.id,
        caption: c,
        use: 'game-workshop-image',
        moment: who.value === 'her' ? 'ws-her' : 'ws-free',
        free: who.value === 'free',
        size: size.value,
        recent: reference(),
      },
      {
        signal: abort.signal,
        onStage: (s) => {
          if (alive) stage.value = s;
        },
      },
    );
    result.value = ws.addDrawing({
      title: out.caption || c.slice(0, 12),
      caption: c,
      who: who.value,
      size: size.value,
      ...(novelId.value ? { novelId: novelId.value } : {}),
      ...(who.value === 'her' ? { characterId: props.character.id } : {}),
      assetKey: out.assetKey,
      ...(out.url ? { url: out.url } : {}),
      prompt: out.prompt,
      negative: out.negative,
      seed: out.seed,
      model: out.model,
    });
  } catch (e) {
    if (!isAbortError(e)) showToast(errorText(e));
  } finally {
    stage.value = null;
    abort = null;
  }
}

function cancel() {
  abort?.abort();
}

function again() {
  const r = result.value;
  if (!r) return;
  caption.value = r.caption;
  who.value = r.who;
  size.value = r.size;
  void draw(r.caption);
}

async function preview() {
  const r = result.value;
  if (!r) return;
  const url = r.assetKey ? await assetUrl(r.assetKey) : r.url;
  if (url) showImagePreview({ images: [url], closeable: true, showIndex: false });
  else showToast('本机找不到这张图了');
}

function remove() {
  const r = result.value;
  if (!r) return;
  ws.removeDrawing(r.id);
  result.value = null;
}
</script>

<template>
  <div class="studio" data-workshop="draw">
    <div class="top">
      <button type="button" class="back" aria-label="回作品列表" @click="emit('back')"><span class="i-lucide-chevron-left" /></button>
      <span class="name">画一张</span>
    </div>
    <div v-if="!imageStatus.live" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">生图 API 还没接通：{{ imageStatus.reason }}</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=image')">去设置</button>
    </div>

    <div class="scroll">
      <!-- 画好的 -->
      <div v-if="result" class="result">
        <button type="button" class="pic" :class="result.size" :aria-label="`看大图：${result.title}`" @click="preview">
          <AssetImg :asset-key="result.assetKey" :url="result.url" :alt="result.title" />
        </button>
        <div class="mt-2 text-[14.5px] font-600">{{ result.title }}</div>
        <button type="button" class="link" @click="showPrompt = !showPrompt">{{ showPrompt ? '收起提示词' : '看看提示词' }}</button>
        <div v-if="showPrompt" class="tags">{{ result.prompt }}</div>
        <div class="actions">
          <van-button type="primary" size="small" round block icon="eye-o" @click="emit('show', result.id)">给{{ character.name }}看</van-button>
          <van-button size="small" round block :disabled="!!stage" @click="again">再画一张</van-button>
          <van-button size="small" round block @click="remove">删</van-button>
        </div>
      </div>

      <div v-if="stage" class="drawing" role="status"><span class="i-lucide-loader-circle spin" />{{ STAGE[stage] }}…</div>

      <Segmented v-model="who" :options="WHO" class="mt-3" />
      <textarea
        v-model="caption"
        class="area mt-2"
        rows="4"
        :placeholder="who === 'her' ? `想画${character.name}在做什么、穿什么、在哪儿` : '想画什么：人物的样子、场景、光线、画风……写得越具体越好'"
        aria-label="想画什么"
      />
      <div v-if="!caption.trim()" class="ideas">
        <button v-for="s in IDEAS" :key="s" type="button" class="chip press" @click="caption = s">{{ s }}</button>
      </div>
      <div class="opts">
        <span class="text-[12.5px] text-ink-2 shrink-0">画幅</span>
        <button v-for="s in SIZES" :key="s.value" type="button" class="opt" :class="{ on: size === s.value }" @click="size = s.value">{{ s.label }}</button>
      </div>
      <div v-if="ws.novels.length" class="opts">
        <span class="text-[12.5px] text-ink-2 shrink-0">参考小说</span>
        <select v-model="novelId" class="select" aria-label="参考小说">
          <option value="">不参考</option>
          <option v-for="n in ws.novels" :key="n.id" :value="n.id">《{{ n.title }}》</option>
        </select>
      </div>
    </div>

    <div class="actions">
      <van-button v-if="stage" size="small" round block @click="cancel">取消</van-button>
      <van-button v-else type="primary" size="small" round block icon="brush-o" :disabled="!caption.trim() || !imageStatus.live" @click="draw()">画</van-button>
    </div>
  </div>
</template>

<style scoped>
.studio {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--panel);
  font-size: 18px;
}
.name {
  font-size: 15px;
  font-weight: 600;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.scroll {
  flex: 1;
  min-height: 0;
  margin-top: 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.result {
  padding: 10px;
  border-radius: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.pic {
  display: block;
  width: 100%;
  max-width: 320px;
  margin: 0 auto;
  overflow: hidden;
  border-radius: 12px;
  background: var(--bg-2);
  aspect-ratio: 2 / 3;
}
.pic.square {
  aspect-ratio: 1;
}
.pic.landscape {
  aspect-ratio: 3 / 2;
}
.pic :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.link {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.tags {
  margin-top: 4px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--bg-2);
  font-family: var(--font-num);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-2);
  word-break: break-word;
}
.drawing {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 13px;
  color: var(--accent-ink);
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
.area {
  width: 100%;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
  font-size: 14px;
  line-height: 1.6;
  resize: none;
}
.ideas {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.ideas .chip {
  height: auto;
  min-height: 28px;
  padding: 5px 10px;
  white-space: normal;
  text-align: left;
  line-height: 1.45;
}
.opts {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.opt {
  padding: 4px 12px;
  border-radius: 99px;
  background: var(--panel);
  border: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--ink-2);
}
.opt.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.select {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
}
.actions {
  display: flex;
  flex: none;
  gap: 8px;
  margin-top: 8px;
}
.actions :deep(.van-button) {
  padding: 0 6px;
  white-space: nowrap;
}
</style>
