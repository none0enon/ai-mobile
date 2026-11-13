<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getLocation, timeOfDay, zonedParts } from '@app/shared';
import Waveform from '@/components/call/Waveform.vue';
import Live2DAvatar from '@/components/call/Live2DAvatar.vue';
import Avatar from '@/components/common/Avatar.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import { useVoiceCall } from '@/composables/useVoiceCall';
import type { CallInput } from '@/stores/voice';
import { useCharacterStore } from '@/stores/characters';
import { useRhythmStore } from '@/stores/rhythm';
import { useEnvironmentStore } from '@/stores/environment';
import { clock, hhmm } from '@/utils/time';

/**
 * 语音通话（设计文档 §11.2）。真的在打：说话检测 → 语音识别 → 主对话（"语音通话"的预设）流式回复 → 按句合成语音边合成边播；
 * 你一开口她就停。怎么接的、哪一步没接通，界面上都写明（composables/useVoiceCall.ts）。
 */
const route = useRoute();
const router = useRouter();
const incoming = route.query.incoming === '1';

/** 来电的缘由：主动消息推过来时带上的，或者按时间猜一个（只是标签，不是她说的话） */
function reasonOf(): string {
  const q = typeof route.query.reason === 'string' ? route.query.reason.trim() : '';
  if (q) return q.slice(0, 60);
  if (!incoming) return '';
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return '叫醒你';
  if (h >= 23 || h < 3) return '催你睡觉';
  return '';
}
const reason = reasonOf();
const charId = computed(() => route.params.charId as string);
const video = ref(route.query.video === '1');
const call = useVoiceCall(charId, { incoming, reason, video: () => video.value });
const { state, character } = call;
const chars = useCharacterStore();
const rhythm = useRhythmStore();
const environment = useEnvironmentStore();
const now = ref(Date.now());
let sceneTimer: ReturnType<typeof setInterval> | undefined;
const slot = computed(() => rhythm.slotNow(character.value.id, new Date(now.value)));
const location = computed(() => getLocation(slot.value?.locationId ?? character.value.locationId));
const backdrop = computed(() => location.value?.backdrop ?? 'room');
const tod = computed(() => timeOfDay(zonedParts(now.value, environment.settings.timezone).hour));
const expression = computed(() => chars.expression[character.value.id] ?? 'neutral');
function toggleVideo() { video.value = !video.value; }

const captionsOn = ref(true);
const typed = ref('');
const typeBox = ref<HTMLInputElement | null>(null);

const status = computed(() => {
  if (state.phase === 'dialing') return '正在呼叫…';
  if (state.muted) return '你已静音';
  if (state.her === 'speaking') return `${character.value.name}在说话`;
  if (state.her === 'thinking') return `${character.value.name}在想…`;
  if (state.you === 'recognizing') return '在听清你说的话…';
  if (state.you === 'speaking') return '在听你说…';
  if (state.input === 'hold') return '按住下面的按钮说话';
  if (state.input === 'type') return `打字和${character.value.pronoun}说`;
  return '轮到你了，直接说话';
});
const level = computed(() => (state.her === 'speaking' ? state.herLevel : state.youLevel));

const INPUTS: { value: CallInput; label: string; icon: string }[] = [
  { value: 'auto', label: '自动听', icon: 'i-lucide-audio-lines' },
  { value: 'hold', label: '按住说', icon: 'i-lucide-hand' },
  { value: 'type', label: '打字', icon: 'i-lucide-keyboard' },
];
const inputMeta = computed(() => INPUTS.find((i) => i.value === state.input) ?? INPUTS[0]!);
function cycleInput() {
  const i = INPUTS.findIndex((x) => x.value === state.input);
  call.setInput(INPUTS[(i + 1) % INPUTS.length]!.value);
}
watch(
  () => state.input,
  (m) => {
    if (m === 'type') void nextTick(() => typeBox.value?.focus());
  },
);

function sendTyped() {
  const t = typed.value.trim();
  if (!t) return;
  typed.value = '';
  void call.youSaid(t, true);
}

/** 按住说话：手指移出按钮也算松开 */
const holding = ref(false);
function holdDown(e: PointerEvent) {
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  holding.value = true;
  call.holdStart();
}
function holdUp() {
  if (!holding.value) return;
  holding.value = false;
  call.holdEnd();
}

async function hangUp() {
  await call.hangUp();
  void router.replace(call.chatId.value ? `/chat/${call.chatId.value}` : '/chats');
}
async function decline() {
  await call.hangUp(true);
  void router.replace(call.chatId.value ? `/chat/${call.chatId.value}` : '/chats');
}
async function busy() {
  await call.replyBusy('在忙，等下打给你');
  void router.replace(call.chatId.value ? `/chat/${call.chatId.value}` : '/chats');
}

/** 哪一步没接通：写明原因，点了去设置 */
const issues = computed(() => {
  const out: { text: string; to: string; icon: string }[] = [];
  if (state.llmIssue) out.push({ text: state.llmIssue, to: '/me/api?feature=main', icon: 'i-lucide-plug-zap' });
  if (state.micIssue) out.push({ text: state.micIssue, to: '/me/voice', icon: 'i-lucide-mic-off' });
  else if (state.sttIssue) out.push({ text: state.sttIssue, to: '/me/api?feature=stt', icon: 'i-lucide-ear-off' });
  if (state.ttsIssue) out.push({ text: state.ttsIssue, to: '/me/api?feature=tts', icon: 'i-lucide-volume-x' });
  else if (!call.voiceLive.value) out.push({ text: `没有声音：语音合成还没接通，或者还没给${character.value.name}选音色（只有字幕）`, to: '/me/voice', icon: 'i-lucide-volume-x' });
  return out;
});

onMounted(() => {
  sceneTimer = setInterval(() => { now.value = Date.now(); }, 15000);
  if (!incoming) call.dial();
});
onBeforeUnmount(() => { clearInterval(sceneTimer); call.dispose(); });
</script>

<template>
  <div class="page call" :class="{ video }" :data-page="video ? 'video-call' : state.phase === 'ringing' ? 'call-incoming' : 'call'" :data-backdrop="video ? backdrop : 'bedroom'" :data-tod="video ? tod : 'late'">
    <SceneBackdrop :kind="video ? backdrop : 'bedroom'" :tod="video ? tod : 'late'" :dim="video ? 0.18 : 0.45" />
    <div v-if="!video" class="call-blur" />

    <!-- 来电 -->
    <div v-if="state.phase === 'ringing'" class="content">
      <div class="text-[13px] text-ink-2 mt-[14vh] num">{{ hhmm(Date.now()) }} · {{ video ? '视频来电' : '语音来电' }}</div>
      <div class="ring-wrap">
        <span class="pulse" /><span class="pulse delay" />
        <Avatar :character="character" :size="116" live />
      </div>
      <div class="text-[26px] font-700">{{ character.name }}</div>
      <div class="text-[15px] text-ink-2 mt-1">邀请你{{ video ? '视频' : '语音' }}通话…</div>
      <div v-if="reason" class="reason">{{ reason }}</div>
      <div class="flex-1" />
      <div class="actions">
        <button class="round decline" aria-label="拒绝" @click="decline"><span class="i-lucide-phone-off" /></button>
        <button class="round accept" aria-label="接听" data-testid="accept" @click="call.accept()"><span class="i-lucide-phone" /></button>
      </div>
      <div class="labels"><span>拒绝</span><span>接听</span></div>
      <button class="busy" @click="busy"><span class="i-lucide-message-square-text" />回消息：在忙，等下打给你</button>
    </div>

    <!-- 呼叫中 / 通话中 -->
    <div v-else class="content">
      <div class="call-title text-[20px] font-700">{{ character.name }}</div>
      <div class="text-[14px] text-ink-2 num">{{ video ? '视频 · ' : '' }}{{ state.phase === 'dialing' ? '等待对方接听…' : `通话中 ${clock(state.seconds)}` }}</div>
      <div v-if="video" class="scene-label">{{ location?.name || '此刻的房间' }}<span v-if="slot?.status"> · {{ slot.status }}</span></div>
      <div v-if="video" class="video-stage">
        <Live2DAvatar v-if="character.live2d" :key="character.live2d.assetId" :config="character.live2d" :expression="expression" :text="state.sentence" :sentence="state.sentenceId" :level="state.herAudioLevel" :audible="state.her === 'speaking' && state.phase !== 'ended'" />
        <div v-else class="missing-model">
          <Avatar :character="character" :size="100" live />
          <p>先为{{ character.name }}上传 Live2D 模型</p>
          <RouterLink :to="`/me/characters/${character.id}?tab=live2d`">去上传模型</RouterLink>
        </div>
      </div>
      <div v-else class="ring-wrap talk" :style="{ '--lv': state.her === 'speaking' ? state.herLevel : 0 }">
        <template v-if="state.phase === 'dialing'"><span class="pulse" /><span class="pulse delay" /></template>
        <span v-else class="glow" />
        <Avatar :character="character" :size="120" live />
      </div>
      <div class="text-[13px]" style="color: var(--accent)" data-testid="call-status">{{ status }}</div>
      <Waveform v-if="!video" :level="level" :tone="state.her === 'speaking' ? 'var(--accent)' : 'var(--ink-2)'" class="mt-1" />

      <div v-if="issues.length" class="issues">
        <button v-for="(x, i) in issues" :key="i" type="button" class="issue" @click="router.push(x.to)">
          <span :class="x.icon" class="shrink-0 mt-[2px]" />
          <span class="flex-1 min-w-0 text-left">{{ x.text }}</span>
          <span class="shrink-0 underline">去设置</span>
        </button>
      </div>

      <div v-if="captionsOn" class="captions" aria-live="polite">
        <p v-for="c in state.captions.slice(video ? -2 : -4)" :key="c.id" :class="[c.who, { pending: c.pending }]">
          <b>{{ c.who === 'her' ? character.name : '我' }}：</b>{{ c.text }}
        </p>
        <p v-if="!state.captions.length" class="text-ink-3 text-[13px]">{{ state.phase === 'dialing' ? '接通后这里显示你们说的话' : '……' }}</p>
      </div>
      <div v-if="state.hint" class="text-[12.5px] text-ink-2 mt-2">{{ state.hint }}</div>

      <div v-if="!video" class="flex-1" />

      <button v-if="state.needTap && state.input !== 'type'" class="tap" @click="call.tapToListen()">
        <span class="i-lucide-mic" />浏览器要先点一下才能听你说话：点这里
      </button>

      <div v-if="state.phase === 'connected' && state.input === 'type'" class="type-row">
        <input ref="typeBox" v-model="typed" class="type-box" :placeholder="`和${character.name}说…`" aria-label="打字说话" enterkeyhint="send" @keydown.enter="sendTyped" />
        <button class="send" :disabled="!typed.trim()" aria-label="发送" @click="sendTyped"><span class="i-lucide-send-horizontal" /></button>
      </div>
      <button
        v-else-if="state.phase === 'connected' && state.input === 'hold'"
        class="hold"
        :class="{ on: holding }"
        :disabled="state.muted"
        @pointerdown.prevent="holdDown"
        @pointerup="holdUp"
        @pointercancel="holdUp"
        @lostpointercapture="holdUp"
        @contextmenu.prevent
      >
        <span class="i-lucide-mic" />{{ holding ? '松开发送' : '按住说话' }}
      </button>

      <div class="ctrls">
        <button class="ctrl" :class="{ on: video }" aria-label="切换视频通话" data-testid="toggle-video" @click="toggleVideo">
          <span class="circle"><span :class="video ? 'i-lucide-video' : 'i-lucide-video-off'" /></span>{{ video ? '视频已开' : '开启视频' }}
        </button>
        <button class="ctrl" :class="{ on: state.muted }" :disabled="state.input === 'type'" @click="call.setMuted(!state.muted)">
          <span class="circle"><span :class="state.muted ? 'i-lucide-mic-off' : 'i-lucide-mic'" /></span>静音
        </button>
        <button class="ctrl" data-testid="call-input" @click="cycleInput">
          <span class="circle"><span :class="inputMeta.icon" /></span>{{ inputMeta.label }}
        </button>
        <button class="ctrl" :class="{ on: captionsOn }" @click="captionsOn = !captionsOn">
          <span class="circle"><span class="i-lucide-captions" /></span>字幕
        </button>
      </div>
      <button class="round decline mx-auto mt-5" aria-label="挂断" data-testid="hangup" @click="hangUp"><span class="i-lucide-phone-off" /></button>
    </div>
  </div>
</template>

<style scoped>
.call {
  color: #fff;
  --ink: #f4edff;
  --ink-2: rgba(244, 237, 255, 0.75);
  --ink-3: rgba(244, 237, 255, 0.55);
}
.call-title { margin-top: 7vh; }
.video .content { overflow-y: auto; }
.video .call-title { margin-top: 16px; }
.video-stage { width: 100%; height: clamp(240px, 40dvh, 460px); flex: 1 0 240px; min-height: 240px; }
.scene-label { font-size: 12px; color: var(--ink-2); margin-top: 4px; text-align: center; }
.missing-model { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 13px; }
.missing-model a { padding: 8px 16px; border-radius: 18px; background: var(--accent); color: var(--on-accent); }
.video .captions { min-height: 56px; max-height: 16vh; background: rgba(12, 10, 22, 0.5); flex-shrink: 0; }
.video .type-row, .video .hold { margin-top: 12px; }
.video .ctrls { margin-top: 12px; }
.video .issues { flex-shrink: 0; }
.call-blur {
  position: absolute;
  inset: 0;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  background: rgba(8, 5, 16, 0.35);
}
.content {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--safe-top) 20px calc(var(--safe-bottom) + 24px);
  min-height: 0;
}
.ring-wrap {
  position: relative;
  margin: 24px 0 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pulse {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  animation: ring-pulse 1.8s ease-out infinite;
}
.pulse.delay {
  animation-delay: 0.9s;
}
.glow {
  position: absolute;
  inset: -14px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-glow), transparent 70%);
  transform: scale(calc(1 + var(--lv) * 0.25));
  transition: transform 0.1s linear;
}
.reason {
  margin-top: 14px;
  padding: 6px 14px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.1);
  font-size: 14px;
}
.actions {
  display: flex;
  justify-content: space-between;
  width: 100%;
  max-width: 280px;
}
.labels {
  display: flex;
  justify-content: space-between;
  width: 100%;
  max-width: 280px;
  padding: 8px 14px 0;
  font-size: 13px;
  color: var(--ink-2);
}
.round {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 68px;
  border-radius: 50%;
  font-size: 28px;
  color: #fff;
  flex-shrink: 0;
}
.decline {
  background: #e5484d;
}
.accept {
  background: #30a46c;
  animation: breathe 1.6s ease-in-out infinite;
}
.busy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 22px;
  font-size: 13.5px;
  color: var(--ink-2);
}
.issues {
  display: grid;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
}
.issue {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(229, 72, 77, 0.18);
  border: 1px solid rgba(229, 72, 77, 0.35);
  color: var(--ink);
  font-size: 12.5px;
  line-height: 1.5;
}
.captions {
  width: 100%;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.07);
  min-height: 92px;
  max-height: 30vh;
  overflow-y: auto;
}
.captions p {
  margin: 0 0 6px;
  font-size: 14.5px;
  line-height: 1.55;
  animation: rise 0.25s var(--ease) both;
}
.captions p.you {
  color: var(--ink-2);
}
.captions p.pending {
  opacity: 0.6;
}
.captions b {
  font-weight: 600;
}
.tap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  padding: 10px 16px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13.5px;
}
.type-row {
  display: flex;
  gap: 8px;
  width: 100%;
  max-width: 420px;
  margin-bottom: 14px;
}
.type-box {
  flex: 1;
  min-width: 0;
  height: 42px;
  padding: 0 16px;
  border-radius: 21px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 15px;
  outline: none;
}
.type-box::placeholder {
  color: var(--ink-3);
}
.send {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}
.send:disabled {
  opacity: 0.5;
}
.hold {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  max-width: 320px;
  height: 52px;
  margin-bottom: 14px;
  border-radius: 26px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.22);
  color: #fff;
  font-size: 15px;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}
.hold.on {
  background: var(--accent);
  color: var(--on-accent);
}
.ctrls {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  width: 100%;
  max-width: 340px;
}
.ctrl {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.ctrl:disabled {
  opacity: 0.45;
}
.circle {
  display: inline-flex;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 24px;
}
.ctrl.on .circle {
  background: #fff;
  color: #1a1024;
}
</style>
