<script setup lang="ts">
import type { Character, MessagePart } from '@app/shared';
import { computed, onBeforeUnmount, ref } from 'vue';
import { showImagePreview, showToast } from 'vant';
import { assetUrl } from '@/services/assets';
import AssetImg from '@/components/common/AssetImg.vue';
import { useChatStore } from '@/stores/chat';
import GenImage from '@/components/figure/GenImage.vue';
import RichText from '@/components/common/RichText.vue';
import { clock } from '@/utils/time';

/** 消息里各种"卡片"的渲染（文字以外的 part） */
const props = defineProps<{ part: MessagePart; character: Character; mine: boolean }>();
const emit = defineEmits<{ (e: 'open-music', part: MessagePart): void; (e: 'answer-date', ok: boolean): void; (e: 'open-image'): void }>();

const showTranscript = ref(false);
const chatStore = useChatStore();
/** 照片：识图正在看 / 看到了 / 没看成 */
const photoState = computed<'looking' | 'seen' | 'failed' | 'idle'>(() => {
  const p = props.part;
  if (p.type !== 'image' || !p.photo) return 'idle';
  if (p.seen) return 'seen';
  if (p.assetKey && chatStore.lookingKeys.has(p.assetKey)) return 'looking';
  return p.seenError ? 'failed' : 'idle';
});
const playing = ref(false);
const MEAL: Record<string, string> = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭', snack: '加餐' };

/** 配图卡片右下角：画到哪一步；画好的写实际出图的模型，没有真图的（演示聊天里的）写"示意图" */
const imageState = computed<'error' | 'drawing' | 'done' | 'placeholder'>(() => {
  const p = props.part;
  if (p.type !== 'image' || p.error) return 'error';
  if (!p.generated) return 'drawing';
  return p.assetKey ? 'done' : 'placeholder';
});
const imageLabel = computed(() => {
  const p = props.part;
  if (p.type !== 'image') return '';
  return { error: '点开重画', drawing: '生成中', done: p.model || '已生成', placeholder: '示意图' }[imageState.value];
});

const bars = computed(() => {
  if (props.part.type !== 'voice') return [];
  const n = Math.min(18, Math.max(6, Math.round(props.part.durationMs / 600)));
  return Array.from({ length: n }, (_, i) => 30 + ((i * 37) % 60));
});

/** 学习卡片里这次画的图：点一张从它开始翻 */
async function previewShots(start: number) {
  const p = props.part;
  if (p.type !== 'study' || !p.images?.length) return;
  const urls = await Promise.all(p.images.map(async (i) => (i.assetKey ? await assetUrl(i.assetKey) : (i.url ?? null))));
  const images = urls.filter((u): u is string => !!u);
  if (images.length) showImagePreview({ images, startPosition: Math.min(start, images.length - 1), closeable: true });
  else showToast('本机找不到这几张图了');
}

let audio: HTMLAudioElement | null = null;
let playback = 0;
function stopVoice() {
  playback += 1;
  audio?.pause();
  audio = null;
  playing.value = false;
}
onBeforeUnmount(stopVoice);

async function playVoice() {
  if (playing.value) return stopVoice();
  if (props.part.type !== 'voice' || !props.part.assetKey) {
    showToast('这条语音没有录音文件');
    return;
  }
  const current = ++playback;
  playing.value = true;
  try {
    const url = await assetUrl(props.part.assetKey);
    if (current !== playback) return;
    if (!url) throw new Error('找不到这条语音的录音文件');
    audio = new Audio(url);
    audio.onended = stopVoice;
    audio.onerror = () => { stopVoice(); showToast('无法播放这条录音'); };
    await audio.play();
  } catch (e) {
    if (current !== playback) return;
    stopVoice();
    showToast(e instanceof Error ? e.message : '无法播放这条录音');
  }
}
</script>

<template>
  <!-- 语音 -->
  <div v-if="part.type === 'voice'" class="pcard voice" :class="{ mine }">
    <button class="flex items-center gap-2 w-full" :aria-label="playing ? '正在播放' : '播放语音'" @click="playVoice">
      <span :class="playing ? 'i-lucide-pause' : 'i-lucide-play'" class="text-[18px] text-accent-ink" />
      <span class="flex items-center gap-[2px] h-6 flex-1">
        <span v-for="(h, i) in bars" :key="i" class="bar" :class="{ live: playing }" :style="{ height: `${h}%`, animationDelay: `${i * 60}ms` }" />
      </span>
      <span class="num text-[12.5px] text-ink-2">{{ Math.round(part.durationMs / 1000) }}″</span>
    </button>
    <button class="text-[12px] text-ink-3 mt-1.5" @click="showTranscript = !showTranscript">
      {{ showTranscript ? '收起文字' : '转文字' }}
    </button>
    <p v-if="showTranscript" class="text-[13.5px] text-ink-2 mt-1">{{ part.transcript }}</p>
  </div>

  <!-- 照片：你拍的、相册里选的 -->
  <button v-else-if="part.type === 'image' && part.photo" class="pcard photo" :class="{ mine }" :data-photo-state="photoState" @click="emit('open-image')">
    <GenImage :part="part" :character="character" class="rounded-[12px]" />
    <div class="photo-note" :class="{ bad: photoState === 'failed' }">
      <span :class="{ looking: 'i-lucide-loader-circle spin-icon', seen: 'i-lucide-scan-eye', failed: 'i-lucide-eye-off', idle: 'i-lucide-scan-eye' }[photoState]" class="shrink-0" />
      <span class="truncate">{{ { looking: '识图在看这张照片…', seen: `识图：${part.seen}`, failed: part.seenError, idle: '还没识图 · 点开重试' }[photoState] }}</span>
    </div>
  </button>

  <!-- 图片 / 配图 -->
  <button v-else-if="part.type === 'image'" class="pcard image" :data-image-state="imageState" @click="emit('open-image')">
    <GenImage :part="part" :character="character" class="rounded-[14px]" />
    <div class="flex items-center gap-1.5 mt-2 text-[12.5px] text-ink-2">
      <span class="i-lucide-wand-sparkles text-accent-ink shrink-0" />
      <span class="truncate">{{ part.title || part.caption }}</span>
      <span class="ml-auto shrink-0 max-w-[48%] truncate" :class="part.error ? 'text-bad' : 'text-ink-3'">{{ imageLabel }}</span>
    </div>
  </button>

  <!-- 歌曲 -->
  <div v-else-if="part.type === 'music'" class="pcard music">
    <span class="disc" />
    <div class="flex-1 min-w-0">
      <div class="font-600 text-[14.5px] truncate">{{ part.title }}</div>
      <div class="text-[12.5px] text-ink-3 truncate">{{ part.artist }} · 网易云</div>
    </div>
    <button class="listen" @click="emit('open-music', part)">
      <span class="i-lucide-headphones" />一起听
    </button>
  </div>

  <!-- 拍一拍 -->
  <div v-else-if="part.type === 'poke'" class="poke">
    <span class="i-lucide-hand text-[13px]" />
    <template v-if="part.actor === 'user'">你拍了拍{{ character.name }}的{{ part.target }}</template>
    <template v-else>{{ character.name }}拍了拍你</template>
  </div>

  <!-- 通话记录 -->
  <div v-else-if="part.type === 'call-log'" class="pcard row-card">
    <span class="icon-wrap"><span :class="part.video ? 'i-lucide-video' : 'i-lucide-phone'" /></span>
    <div class="flex-1">
      <div class="text-[14.5px]">
        {{ part.missed ? (mine ? '已取消' : '未接来电') : part.video ? '视频通话' : '语音通话' }} <span v-if="!part.missed" class="num">{{ clock(part.durationSec) }}</span>
      </div>
      <div v-if="part.scene" class="text-[12px] text-ink-3">{{ part.scene }}</div>
    </div>
  </div>

  <!-- 运动 -->
  <div v-else-if="part.type === 'workout'" class="pcard activity" style="--tone: #7fd1b1">
    <div class="flex items-center gap-2 text-[12.5px] text-ink-2">
      <span class="i-lucide-footprints" style="color: var(--tone)" />运动记录 · {{ part.sport }}
    </div>
    <div class="grid grid-cols-3 gap-2 mt-2">
      <div><div class="big num">{{ part.distanceKm }}</div><div class="label">公里</div></div>
      <div><div class="big num">{{ clock(part.durationSec) }}</div><div class="label">用时</div></div>
      <div><div class="big num">{{ part.pace }}</div><div class="label">配速</div></div>
    </div>
  </div>

  <!-- 饭照 -->
  <div v-else-if="part.type === 'meal'" class="pcard meal">
    <div class="meal-photo"><span class="i-lucide-soup text-[34px]" /></div>
    <div class="p-3">
      <div class="text-[12.5px] text-ink-3">{{ MEAL[part.meal] ?? '一顿饭' }}</div>
      <div class="font-600 text-[14.5px]">{{ part.food }}</div>
    </div>
  </div>

  <!-- 学习 -->
  <div v-else-if="part.type === 'read'" class="pcard row-card" style="--tone: #d9a77a">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-book-open-text" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">一起读《{{ part.title }}》</div>
      <div class="text-[12px] text-ink-3 truncate">{{ part.chapter }} · 全书 {{ part.progress }}%<template v-if="part.notes"> · {{ part.notes }} 条批注</template></div>
      <div v-if="part.quote" class="text-[12.5px] text-ink-2 mt-0.5">「<RichText :text="part.quote" />」</div>
    </div>
  </div>
  <div v-else-if="part.type === 'game'" class="pcard row-card" style="--tone: #b9a3e6">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-puzzle" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">海龟汤 · 《{{ part.title }}》</div>
      <div class="text-[12px] text-ink-3">
        {{ { solved: '猜出来了', partial: '猜对了一半', 'gave-up': '认输了' }[part.result] }} · 问了 {{ part.questions }} 个问题<template v-if="part.hints"> · 提示 {{ part.hints }} 次</template>
      </div>
      <div v-if="part.truth" class="text-[12.5px] text-ink-2 mt-0.5">汤底：{{ part.truth }}</div>
    </div>
  </div>
  <div v-else-if="part.type === 'watch'" class="pcard row-card" style="--tone: #e07a7a">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-ticket" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">票根 · 《{{ part.title }}》</div>
      <div class="text-[12px] text-ink-3">
        一起看了 {{ part.minutes }} 分钟<template v-if="part.yourScore"> · 你 {{ part.yourScore }}/5</template><template v-if="part.herScore"> · {{ character.pronoun }} {{ part.herScore }}/5</template>
      </div>
      <div v-for="(h, i) in part.highlights ?? []" :key="i" class="text-[12.5px] text-ink-2 mt-0.5 truncate">「{{ h }}」</div>
      <a v-if="part.link" :href="part.link" target="_blank" rel="noopener noreferrer" class="block text-[12px] text-accent-ink mt-1 truncate">{{ part.link }}</a>
    </div>
  </div>
  <div v-else-if="part.type === 'study'" class="pcard row-card" style="--tone: #8fb3f0">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-book-open" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px]">
        陪伴学习 · <template v-if="!part.timer || part.timer === 'pomodoro'">{{ part.pomodoros }} 个番茄</template><template v-else>{{ part.timer === 'countdown' ? '倒计时' : '正计时' }}</template><template v-if="part.together === false"> · 各自专注</template>
      </div>
      <div class="text-[12px] text-ink-3">
        专注 {{ part.minutes }} 分钟<template v-if="part.tasks?.length"> · 完成 {{ part.tasks.filter((t) => t.done).length }} / {{ part.tasks.length }} 个任务</template><template v-if="part.promise"> · 约定{{ part.promise.kept ? '做到了' : '没做到' }}</template>
      </div>
      <div v-if="part.diary" class="text-[12.5px] text-ink-2 mt-1">{{ part.diary }}</div>
      <div v-if="part.images?.length" class="shots">
        <button v-for="(img, i) in part.images" :key="i" type="button" class="shot" :aria-label="`看大图：${img.title}`" @click="previewShots(i)">
          <AssetImg :asset-key="img.assetKey" :url="img.url" :alt="img.title" />
        </button>
      </div>
    </div>
  </div>

  <!-- 约会 -->
  <div v-else-if="part.type === 'date'" class="pcard date">
    <div class="flex items-center gap-2">
      <span class="icon-wrap" style="color: #ff9fa8"><span class="i-lucide-heart-handshake" /></span>
      <div class="flex-1 min-w-0">
        <div class="text-[12.5px] text-ink-3">约会邀请</div>
        <div class="font-600 text-[14.5px] truncate">{{ part.when }} · {{ part.place }}</div>
      </div>
    </div>
    <div v-if="part.status === 'invite' && !mine" class="flex gap-2 mt-2.5">
      <button class="flex-1 h-9 rounded-full bg-accent text-[var(--on-accent)] text-[13.5px] font-600 press" @click="emit('answer-date', true)">答应她</button>
      <button class="flex-1 h-9 rounded-full bg-panel text-[13.5px] press" @click="emit('answer-date', false)">再想想</button>
    </div>
    <div v-else class="text-[12.5px] text-ink-3 mt-2">{{ part.status === 'accepted' ? '已答应 · 到时候她会提醒你' : part.status === 'memory' ? '已存进回忆' : '' }}</div>
  </div>

  <!-- 场景分段：和她一起去了某个地点 / 离开 -->
  <div v-else-if="part.type === 'scene'" class="scene-mark" :class="part.event">
    <span class="line" />
    <span class="label">
      <span :class="part.event === 'enter' ? 'i-lucide-map-pin' : 'i-lucide-footprints'" />
      {{ part.title }}<template v-if="part.summary"> · {{ part.summary }}</template>
    </span>
    <span class="line" />
  </div>

  <div v-else-if="part.type === 'gift'" class="pcard row-card">
    <span class="icon-wrap"><span class="i-lucide-gift" /></span>
    <div class="text-[14.5px]">送出礼物：{{ part.name }}</div>
  </div>
</template>

<style scoped>
.pcard {
  display: block;
  width: 100%;
  max-width: 260px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--bubble-ai);
  border: 1px solid var(--border);
  color: var(--ink);
  text-align: left;
}
.voice {
  min-width: 170px;
}
.voice.mine {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.bar {
  width: 3px;
  border-radius: 2px;
  background: var(--accent-ink);
  opacity: 0.55;
}
.bar.live {
  animation: typing 0.9s infinite;
  opacity: 1;
}
.image {
  padding: 6px 6px 8px;
  width: 210px;
}
.photo {
  padding: 4px 4px 6px;
  width: 190px;
}
.photo.mine {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.photo-note {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 5px 4px 0;
  font-size: 11.5px;
  color: var(--ink-3);
}
.photo-note.bad {
  color: var(--warn);
}
.spin-icon {
  animation: spin 1s linear infinite;
}
.music {
  display: flex;
  align-items: center;
  gap: 10px;
}
.disc {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  flex-shrink: 0;
  background:
    radial-gradient(circle, var(--bubble-ai) 0 4px, transparent 5px),
    repeating-radial-gradient(circle, #2a2233 0 2px, #1a1522 2px 4px);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.listen {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12.5px;
  font-weight: 600;
  flex-shrink: 0;
}
.poke {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 12px;
}
.row-card {
  display: flex;
  align-items: center;
  gap: 10px;
}
.icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--accent-ink);
  font-size: 18px;
  flex-shrink: 0;
}
.activity .big {
  font-size: 19px;
  font-weight: 700;
  line-height: 1.1;
}
.activity .label {
  font-size: 11px;
  color: var(--ink-3);
}
.meal {
  padding: 0;
  overflow: hidden;
  width: 200px;
}
.scene-mark {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 340px;
  margin: 8px 0 2px;
  color: var(--accent-ink);
  font-size: 12px;
}
.scene-mark.leave {
  color: var(--ink-3);
}
.scene-mark .line {
  flex: 1;
  height: 1px;
  background: currentColor;
  opacity: 0.35;
}
.scene-mark .label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 78%;
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--panel);
  text-align: center;
}
.meal-photo {
  height: 110px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, #e8a86c, #b8603f);
}
.shots {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  overflow-x: auto;
}
.shot {
  flex-shrink: 0;
  width: 54px;
  height: 72px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}
</style>
