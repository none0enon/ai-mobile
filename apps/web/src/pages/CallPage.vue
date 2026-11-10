<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Waveform from '@/components/call/Waveform.vue';
import Avatar from '@/components/common/Avatar.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import { services } from '@/services';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { sleep } from '@/utils/id';
import { clock, hhmm } from '@/utils/time';

/**
 * 语音通话。正式版管线：VAD 检测你说完 → STT → 主对话（通话预设：短句、不写动作）→ 分句 TTS 播放；你一开口就打断她。
 * 这里用假 TTS / STT 模拟一来一回，演示字幕、声波、计时和控制按钮。
 */
const route = useRoute();
const router = useRouter();
const chars = useCharacterStore();
const chat = useChatStore();
const character = computed(() => chars.byId(route.params.charId as string) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(character.value.id)?.id);

const incoming = ref(route.query.incoming === '1');
const seconds = ref(0);
const level = ref(0);
const speaker = ref<'her' | 'you' | 'idle'>('idle');
const muted = ref(false);
const loud = ref(false);
const captionsOn = ref(true);
const captions = ref<{ who: 'her' | 'you'; text: string }[]>([]);
let alive = true;
let clockTimer: ReturnType<typeof setInterval> | undefined;

const reason = computed(() => {
  const h = new Date().getHours();
  if (h < 9) return '早上好～该起床啦（叫醒来电）';
  if (h >= 23 || h < 2) return '还不睡？我来催你了';
  return '想你了，接一下嘛';
});

const SCRIPT: { who: 'her' | 'you'; text: string }[] = [
  { who: 'her', text: '喂？……嗯，是我。' },
  { who: 'you', text: '怎么突然打电话来了' },
  { who: 'her', text: '没什么，就是想听听你的声音。' },
  { who: 'you', text: '今天论文写得好累' },
  { who: 'her', text: '辛苦啦。先别想了，深呼吸……对，就这样。' },
  { who: 'you', text: '嗯……' },
  { who: 'her', text: '我陪你一会儿，你困了就直接睡，不用挂。' },
];

async function talkLoop() {
  for (const turn of SCRIPT) {
    if (!alive) return;
    if (turn.who === 'her') {
      speaker.value = 'her';
      captions.value.push(turn);
      chars.setExpression(character.value.id, 'smile');
      await services.tts.speak(turn.text, { onLevel: (l) => (level.value = l) });
    } else {
      speaker.value = 'you';
      for (let i = 0; i < 14 && alive; i += 1) {
        level.value = muted.value ? 0 : 0.2 + Math.random() * 0.5;
        await sleep(120);
      }
      level.value = 0;
      if (!muted.value) captions.value.push(turn);
    }
    speaker.value = 'idle';
    await sleep(500);
  }
}

function accept() {
  incoming.value = false;
  start();
}

function start() {
  clearInterval(clockTimer);
  clockTimer = setInterval(() => (seconds.value += 1), 1000);
  void services.native.keepAwake(true);
  void talkLoop();
}

function hangUp(missed = false) {
  alive = false;
  services.tts.stop();
  clearInterval(clockTimer);
  void services.native.keepAwake(false);
  if (chatId.value) {
    chat.postCard(chatId.value, missed ? 'assistant' : 'user', { type: 'call-log', durationSec: seconds.value, missed, scene: missed ? undefined : '语音通话' });
    if (missed) chat.push(chatId.value, 'assistant', [{ type: 'text', text: '……不接我电话。好吧，你忙完记得回我。' }], { expression: 'pout', proactive: true });
    void router.replace(`/chat/${chatId.value}`);
  } else {
    router.back();
  }
}

function replyBusy() {
  alive = false;
  if (chatId.value) {
    chat.push(chatId.value, 'user', [{ type: 'text', text: '在忙，等下打给你' }]);
    void router.replace(`/chat/${chatId.value}`);
  }
}

onMounted(() => {
  if (!incoming.value) start();
});
onBeforeUnmount(() => {
  alive = false;
  services.tts.stop();
  clearInterval(clockTimer);
});

const status = computed(() => (speaker.value === 'her' ? `${character.value.name}在说话` : speaker.value === 'you' ? (muted.value ? '已静音' : '正在聆听你…') : '……'));
</script>

<template>
  <div class="page call" :data-page="incoming ? 'call-incoming' : 'call'">
    <SceneBackdrop kind="bedroom" tod="late" :dim="0.45" />
    <div class="call-blur" />

    <!-- 来电 -->
    <div v-if="incoming" class="content">
      <div class="text-[13px] text-ink-2 mt-[14vh] num">{{ hhmm(Date.now()) }} · 语音来电</div>
      <div class="ring-wrap">
        <span class="pulse" /><span class="pulse delay" />
        <Avatar :character="character" :size="116" live />
      </div>
      <div class="text-[26px] font-700">{{ character.name }}</div>
      <div class="text-[15px] text-ink-2 mt-1">邀请你语音通话…</div>
      <div class="reason">「{{ reason }}」</div>
      <div class="flex-1" />
      <div class="actions">
        <button class="round decline" aria-label="拒绝" @click="hangUp(true)"><span class="i-lucide-phone-off" /></button>
        <button class="round accept" aria-label="接听" @click="accept"><span class="i-lucide-phone" /></button>
      </div>
      <div class="labels"><span>拒绝</span><span>接听</span></div>
      <button class="busy" @click="replyBusy"><span class="i-lucide-message-square-text" />回消息：在忙，等下打给你</button>
    </div>

    <!-- 通话中 -->
    <div v-else class="content">
      <div class="mt-[8vh] text-[20px] font-700">{{ character.name }}</div>
      <div class="text-[14px] text-ink-2 num">通话中 {{ clock(seconds) }}</div>
      <div class="ring-wrap talk" :style="{ '--lv': speaker === 'her' ? level : 0 }">
        <span class="glow" />
        <Avatar :character="character" :size="128" live />
      </div>
      <div class="text-[13px]" style="color: var(--accent)">{{ status }}</div>
      <Waveform :level="level" :tone="speaker === 'you' ? 'var(--ink-2)' : 'var(--accent)'" class="mt-1" />
      <div v-if="captionsOn" class="captions">
        <p v-for="(c, i) in captions.slice(-3)" :key="`${captions.length}-${i}`" :class="c.who">
          <b>{{ c.who === 'her' ? character.name : '我' }}：</b>{{ c.text }}
        </p>
      </div>
      <div class="flex-1" />
      <div class="ctrls">
        <button class="ctrl" :class="{ on: muted }" @click="muted = !muted">
          <span class="circle"><span :class="muted ? 'i-lucide-mic-off' : 'i-lucide-mic'" /></span>静音
        </button>
        <button class="ctrl" :class="{ on: loud }" @click="loud = !loud">
          <span class="circle"><span class="i-lucide-volume-2" /></span>免提
        </button>
        <button class="ctrl" :class="{ on: captionsOn }" @click="captionsOn = !captionsOn">
          <span class="circle"><span class="i-lucide-captions" /></span>字幕
        </button>
      </div>
      <button class="round decline mx-auto mt-5" aria-label="挂断" @click="hangUp()"><span class="i-lucide-phone-off" /></button>
      <div class="text-[12px] text-ink-3 mt-3 text-center">演示：语音是模拟的 · 正式版首句目标 2 秒内、可打断</div>
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
  padding: var(--safe-top) 24px calc(var(--safe-bottom) + 28px);
}
.ring-wrap {
  position: relative;
  margin: 28px 0 18px;
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
  padding: 8px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 14.5px;
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
.captions {
  width: 100%;
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.07);
  min-height: 96px;
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
.captions b {
  font-weight: 600;
}
.ctrls {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  width: 100%;
  max-width: 300px;
}
.ctrl {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-2);
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
