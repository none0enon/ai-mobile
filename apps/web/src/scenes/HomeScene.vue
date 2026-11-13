<script setup lang="ts">
import { CHORE_KINDS, effectLine, type ChoreItem, type MealKey, type PlanMeal } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Waveform from '@/components/call/Waveform.vue';
import Segmented from '@/components/common/Segmented.vue';
import MealCard from '@/components/health/MealCard.vue';
import PlaylistMusic from '@/components/scene/PlaylistMusic.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { useMicLink } from '@/composables/useMicLink';
import { services } from '@/services';
import { choreMusic, type PlaylistSearch } from '@/services/musicPlayer';
import { personaOf } from '@/services/prompt';
import { SpeechQueue } from '@/services/speech';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useHealthStore } from '@/stores/health';
import { useHomeStore } from '@/stores/home';
import { sleep } from '@/utils/id';
import { clock, hhmm } from '@/utils/time';

/**
 * 共同的家（设计文档 §9.12）：你和她的家。开了家务系统时，按你人设里的家务列出今天要做的。
 * - 点"开始"开始做：计时，可以放歌（挑歌单）、边做边和她聊（打字，或者连麦说话）；做饭时能看今天计划里的菜谱；
 * - 做完打勾（开始以后点"做完了"，或者直接点左边的圈）：她具体地夸你（「陪伴 · 快速」按"共同的家"功能预设的"做完了"一块）；
 * - "晚点做"是拖一次：她按这件家务"没做时她会怎样"来反应（嫌弃、不肯出门、有点失落……）；拖几次她都记着；
 * - 做完、拖延都发一张家务卡片进聊天（总结时会记成你的习惯），离开时那一段记"做完了几件家务"。
 * 今天的情况也写进聊天、通话、主动消息的提示词（"家务和健康"那一块），所以平时聊天她也知道你没洗澡、衣服拖着没洗。
 * 没接通「陪伴 · 快速」时照样能勾，她不说话，界面写明原因。
 */
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const ai = useAiStore();
const home = useHomeStore();
const health = useHealthStore();
const router = useRouter();

const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const persona = computed(() => personaOf(chat.chatById(chatId.value)));
const userName = computed(() => persona.value.name);
const enabled = computed(() => !!persona.value.housework?.enabled && !!persona.value.housework.chores.length);
const settingsLink = computed(() => `/me/personas/${persona.value.id}/housework`);

/** 做家务时放的歌：轻快的几个 */
const CHORE_SEARCHES: PlaylistSearch[] = [
  { name: '轻快', keyword: '轻快 治愈 日常', icon: 'i-lucide-sparkles' },
  { name: '做家务', keyword: '做家务 BGM', icon: 'i-lucide-house' },
  { name: '元气', keyword: '元气 活力 歌曲', icon: 'i-lucide-sun' },
  { name: 'City Pop', keyword: 'city pop', icon: 'i-lucide-disc-3' },
  { name: '咖啡馆', keyword: '咖啡馆 爵士', icon: 'i-lucide-coffee' },
];

// —— 今天的清单 ——
const items = computed<ChoreItem[]>(() => home.itemsFor(persona.value));
const doing = computed(() => items.value.find((it) => it.mark.status === 'doing') ?? null);
const todo = computed(() => items.value.filter((it) => it.mark.status === 'todo'));
const later = computed(() => items.value.filter((it) => it.mark.status === 'later'));
const done = computed(() => items.value.filter((it) => it.mark.status === 'done'));
const doneCount = computed(() => done.value.length);
const allDone = computed(() => items.value.length > 0 && doneCount.value === items.value.length);
/** 这次进来做完了几件（离开时那一段的总结） */
const doneHere = ref<string[]>([]);

function iconOf(it: ChoreItem) {
  return CHORE_KINDS[it.chore.kind].icon;
}
function subOf(it: ChoreItem): string {
  const parts = [it.when, `约 ${it.chore.minutes} 分钟`];
  if (it.mark.status === 'done') parts.splice(0, 2, `${it.mark.doneAt ? hhmm(it.mark.doneAt) : ''} 做完了${it.mark.spentSec ? ` · ${Math.max(1, Math.round(it.mark.spentSec / 60))} 分钟` : ''}`);
  else if (it.mark.status === 'later') parts.push(`拖了 ${it.mark.later ?? 1} 次`);
  else if (it.carriedFrom) parts.splice(1, 1);
  else if (it.overdue) parts.push('过了时间');
  else if (it.early) parts.push('还没到时候');
  if (it.mark.status !== 'done' && it.missedDays > 1) parts.push(`已经 ${it.missedDays} 天没做`);
  return parts.filter(Boolean).join(' · ');
}

// —— 她说的话：都来自「陪伴 · 快速」，存进聊天 ——
const companion = computed(() => ai.status('companion'));
/** 「陪伴 · 快速」没接通的原因（接通了是空的） */
const companionIssue = computed(() => {
  const c = companion.value;
  return c.live ? '' : `「陪伴 · 快速」还没接通：${c.reason}。照样能勾，${her.value.pronoun}先不说话`;
});
const notConnected = ref('');
const herLine = ref('');
const stream = computed(() => (chatId.value ? chat.streams[chatId.value] : undefined));
const streamingText = computed(() => (stream.value ? (chat.list(chatId.value).find((m) => m.id === stream.value!.messageId)?.text ?? '') : ''));
/** 边做边聊时这一段说过的几句（你的、她的） */
const talk = ref<{ who: 'her' | 'you'; text: string }[]>([]);

function remainingText(): string {
  const left = items.value.filter((it) => it.mark.status !== 'done' && !it.early);
  return left.length ? `今天还没做的：${left.map((it) => it.label).join('、')}` : '今天要做的家务都做完了';
}
function progressLine(): string {
  return `今天的家务做完了 ${doneCount.value} / ${items.value.length} 件`;
}
/** 做饭这件对应今天计划里的哪一顿 */
function mealFor(it: ChoreItem | null): { key: MealKey; meal: PlanMeal } | null {
  if (!it || it.chore.kind !== 'cooking') return null;
  const day = health.dayOf(persona.value.id);
  if (!day) return null;
  const key: MealKey = it.slot === 'morning' ? 'breakfast' : it.slot === 'noon' ? 'lunch' : 'dinner';
  const meal = day.meals[key];
  return meal ? { key, meal } : null;
}

/** 她还在回上一句（开始做时的那句）：先停下，免得做完的夸奖被挡掉 */
async function settle() {
  const id = chatId.value;
  if (!id || !chat.streams[id]) return;
  chat.stop(id);
  for (let i = 0; i < 40 && chat.streams[id]; i += 1) await sleep(50);
}

async function reply(task: string, lines: string[], userText?: string, cue?: string): Promise<boolean> {
  if (!chatId.value) return false;
  if (!userText) await settle();
  const r = await chat.sceneReply(chatId.value, { task, input: lines.filter(Boolean).join('\n'), userText, cue });
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else if (!/还在回上一句/.test(r.reason)) showToast(r.reason);
    return false;
  }
  notConnected.value = '';
  herLine.value = r.message.text;
  talk.value.push({ who: 'her', text: r.message.text });
  if (talk.value.length > 12) talk.value.splice(0, talk.value.length - 12);
  return true;
}

function postCard(it: ChoreItem, status: 'done' | 'later', minutes?: number) {
  if (!chatId.value) return;
  chat.push(chatId.value, 'user', [{ type: 'chore', choreId: it.chore.id, name: it.label, status, ...(minutes ? { minutes } : {}), ...(it.mark.later ? { later: it.mark.later } : {}) }], { meta: { scene: 'home', cue: it.label } });
}

// —— 开始、做完、拖延 ——
const elapsedNow = ref(Date.now());
const ticker = setInterval(() => (elapsedNow.value = Date.now()), 1000);
const elapsedSec = computed(() => (doing.value?.mark.startedAt ? Math.max(0, Math.floor((elapsedNow.value - doing.value.mark.startedAt) / 1000)) : 0));
const expectSec = computed(() => (doing.value ? doing.value.chore.minutes * 60 : 0));
const tab = ref<'talk' | 'music' | 'recipe'>('talk');
const doingTabs = computed(() => [
  { value: 'talk' as const, label: link.state.on ? '连麦中' : '聊天', icon: link.state.on ? 'i-lucide-headphones' : 'i-lucide-message-circle' },
  { value: 'music' as const, label: '音乐', icon: 'i-lucide-music' },
  ...(mealFor(doing.value) ? [{ value: 'recipe' as const, label: '菜谱', icon: 'i-lucide-chef-hat' }] : []),
]);

async function start(it: ChoreItem) {
  home.startChore(persona.value, it.key);
  services.native.vibrate(12);
  talk.value = [];
  tab.value = mealFor(it) ? 'recipe' : 'talk';
  const recipe = mealFor(it);
  await reply('chore-start', [
    `${userName.value}开始做：${it.label}（大概要 ${it.chore.minutes} 分钟）`,
    it.mark.later ? `这件之前说了晚点做，拖了 ${it.mark.later} 次` : it.carriedFrom ? `这件是之前该做没做、拖到今天的` : it.overdue ? '已经过了该做的时间' : '',
    it.missedDays > 1 ? `之前已经 ${it.missedDays} 天没做了` : '',
    recipe ? `今天计划做：${recipe.meal.name}` : it.chore.kind === 'cooking' && it.chore.effectNote ? `你最想吃${userName.value}做的：${it.chore.effectNote}` : '',
    progressLine(),
  ], undefined, `开始${it.label}`);
}

async function finish(it: ChoreItem) {
  const wasLater = it.mark.later ?? 0;
  const m = home.finish(persona.value, it.key);
  const minutes = m.spentSec ? Math.max(1, Math.round(m.spentSec / 60)) : undefined;
  doneHere.value.push(it.label);
  services.native.vibrate([20, 60, 20]);
  chars.setExpression(her.value.id, 'smile');
  postCard({ ...it, mark: m }, 'done', minutes);
  if (link.state.on && !doing.value) void link.hangUp();
  const recipe = mealFor(it);
  await reply('chore-done', [
    `${userName.value}做完了：${it.label}${minutes ? `，做了 ${minutes} 分钟` : '（直接打了勾）'}`,
    wasLater ? `之前拖了 ${wasLater} 次` : '',
    it.overdue || it.missedDays ? `没做时你会：${effectLine(it.chore, userName.value) || '不在意'}（现在做完了）` : '',
    recipe ? `做的是今天计划里的：${recipe.meal.name}` : '',
    progressLine(),
    remainingText(),
  ], undefined, `做完${it.label}`);
}

async function procrastinate(it: ChoreItem) {
  const m = home.postpone(persona.value, it.key);
  services.native.vibrate(10);
  postCard({ ...it, mark: m }, 'later');
  if (link.state.on) void link.hangUp();
  chars.setExpression(her.value.id, (m.later ?? 1) > 1 ? 'pout' : 'neutral');
  await reply('chore-later', [
    `${userName.value}说"${it.label}"晚点再做（这是第 ${m.later ?? 1} 次拖）`,
    `这件没做时你会：${effectLine(it.chore, userName.value) || '不在意'}`,
    it.overdue ? '已经过了该做的时间' : '',
    it.missedDays > 1 ? `之前已经 ${it.missedDays} 天没做了` : '',
    remainingText(),
  ], undefined, `拖延${it.label}`);
}

async function undo(it: ChoreItem) {
  try {
    await showConfirmDialog({ title: `"${it.label}"改回没做？`, message: '勾错了就改回来（聊天里的卡片不动）。', confirmButtonText: '改回没做' });
  } catch {
    return;
  }
  home.undo(persona.value, it.key);
  doneHere.value = doneHere.value.filter((x) => x !== it.label);
}

// —— 边做边聊：打字 ——
const text = ref('');
async function sendText() {
  const t = text.value.trim();
  if (!t || stream.value) return;
  text.value = '';
  talk.value.push({ who: 'you', text: t });
  const it = doing.value;
  await reply('chore-chat', [it ? `${userName.value}正在做：${it.label}（做了 ${Math.max(1, Math.round(elapsedSec.value / 60))} 分钟）` : `${userName.value}没在做家务，在家里跟你聊天`, nowLine(), progressLine()], t, it ? it.label : '在家');
}

// —— 边做边聊：连麦（说话她就听得到，用她的声音回你） ——
const level = ref(0);
let speech: SpeechQueue | null = null;
function newSpeech(o: { onSentence?(text: string, i: number): void } = {}): SpeechQueue {
  speech?.stop();
  const q = new SpeechQueue({ characterId: her.value.id, onLevel: (l) => (level.value = l), onSentence: o.onSentence });
  speech = q;
  choreMusic.duck(true);
  void q.drained().then(() => {
    if (speech === q) choreMusic.duck(false);
  });
  return q;
}
function nowLine(): string {
  const parts = [`现在 ${hhmm(Date.now())}`];
  const s = choreMusic.current();
  if (s && choreMusic.state.playing) parts.push(`在放《${s.title}》- ${s.artist}${choreMusic.state.demo ? '（示例歌曲）' : ''}`);
  return `${parts.join('，')}。`;
}
const link = useMicLink({
  chatId,
  character: her,
  userName,
  newSpeech: (o) => newSpeech({ onSentence: o.onSentence }),
  context: () => {
    const it = doing.value;
    return `${nowLine()}${it ? `${userName.value}在做：${it.label}（做了 ${Math.max(1, Math.round(elapsedSec.value / 60))} 分钟）。` : ''}${progressLine()}。`;
  },
  herBusy: () => false,
  onInterrupt: () => undefined,
  autoWhisper: () => false,
  tasks: { reply: 'chore-call' },
  input: (kind, info) =>
    kind === 'open'
      ? `${info.context}你们刚连上麦，${userName.value}一边做家务一边跟你说话。先开口说第一句，1–2 个短句。`
      : `${info.context}连麦中（已经连了 ${info.linked}）。回${userName.value}刚才说的话。`,
});
const linkStatus = computed(() => {
  const s = link.state;
  const p = her.value.pronoun;
  if (s.her === 'speaking') return `${p}在说……`;
  if (s.her === 'thinking') return `${p}在想……`;
  if (s.you === 'recognizing') return '在听清你说的话……';
  if (s.you === 'speaking') return '在听你说……';
  if (s.input === 'type') return `打字和${p}说`;
  if (s.muted) return '你闭麦了';
  return `说话${p}就听得到`;
});
const linkIssue = computed(() => link.state.micIssue || link.state.sttIssue || link.state.llmIssue);
const typed = ref('');
function sendTyped() {
  const t = typed.value.trim();
  if (!t) return;
  typed.value = '';
  void link.say(t);
}

// —— 她的那句话：连麦时是她最近说的那句，平时是最近一次回复 ——
const lastCaption = computed(() => [...link.state.captions].reverse().find((c) => c.who === 'her')?.text ?? '');
const shownLine = computed(() => {
  if (link.state.on && lastCaption.value) return lastCaption.value;
  if (streamingText.value) return streamingText.value;
  if (herLine.value) return herLine.value;
  if (!enabled.value) return '';
  if (allDone.value) return '今天的家务都做完啦，过来让我抱一下～';
  const left = items.value.length - doneCount.value;
  return left ? `回来啦。今天的家务还剩 ${left} 件哦。` : '';
});

// —— 今天吃什么（开了健康系统、排了今天的计划时） ——
const meals = computed(() => {
  const day = persona.value.health?.enabled ? health.dayOf(persona.value.id) : undefined;
  if (!day) return [];
  return (['breakfast', 'lunch', 'dinner'] as const).filter((k) => day.meals[k]).map((k) => ({ key: k, meal: day.meals[k]! }));
});
const mealsOpen = ref(false);
const doneOpen = ref(false);

onMounted(() => {
  home.tick();
  // 离开时那一段写"做完了几件家务"
  chat.setLeaveSummary(her.value.id, () => (doneHere.value.length ? `做完了${doneHere.value.length > 3 ? ` ${doneHere.value.length} 件家务` : `：${doneHere.value.join('、')}`}` : undefined));
});
onBeforeUnmount(() => {
  // 离开时那一段的总结已经在离开前取走了（ScenePage 的 onBeforeRouteLeave）
  chat.setLeaveSummary(her.value.id, null);
  clearInterval(ticker);
  link.dispose();
  speech?.stop();
  choreMusic.stop();
  if (chat.streams[chatId.value]) chat.stop(chatId.value);
});
</script>

<template>
  <SceneShell scene-id="home" backdrop="living" :line="shownLine" :typing="!!stream && !streamingText" :layout="{ left: 72, bottom: 47, height: 36 }">
    <template #actions>
      <RouterLink :to="settingsLink" class="pill-btn" aria-label="家务设置"><span class="i-lucide-settings-2" /></RouterLink>
    </template>

    <div v-if="enabled && (notConnected || companionIssue)" class="notice" data-testid="home-notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ notConnected || companionIssue }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>

    <!-- 没开家务系统 -->
    <div v-if="!enabled" class="empty" data-testid="home-off">
      <span class="i-lucide-house-heart text-[30px] text-accent-ink" />
      <div class="text-[15.5px] font-600 mt-1.5">{{ persona.housework?.enabled ? '还没有要做的家务' : '家务系统还没打开' }}</div>
      <p class="text-[13px] text-ink-3 leading-relaxed mt-1 mb-3">
        打开以后，这里每天按你设好的家务列出今天要做的：刷牙、洗澡、洗衣服、做饭……做完打勾{{ her.name }}会夸你，拖着不做{{ her.pronoun }}也会有反应（嫌弃、不肯出门、有点失落）。
      </p>
      <van-button type="primary" round size="small" data-testid="home-setup" @click="router.push(settingsLink)">去设置家务</van-button>
    </div>

    <!-- 正在做 -->
    <template v-else-if="doing">
      <div class="doing" data-testid="chore-doing">
        <div class="flex items-center gap-3">
          <span class="chore-icon big"><span :class="iconOf(doing)" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[12px] text-ink-3">正在做</div>
            <div class="text-[17px] font-700 truncate">{{ doing.label }}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="num text-[22px] font-700 leading-none">{{ clock(elapsedSec) }}</div>
            <div class="text-[11.5px] text-ink-3 mt-1">约 {{ doing.chore.minutes }} 分钟</div>
          </div>
        </div>
        <span class="bar" aria-hidden="true"><span :style="{ width: `${Math.min(100, Math.round((elapsedSec / Math.max(1, expectSec)) * 100))}%` }" /></span>
        <div class="flex gap-2.5 mt-3">
          <van-button round block size="small" data-testid="chore-pause" @click="procrastinate(doing)">先放一放</van-button>
          <van-button type="primary" round block size="small" data-testid="chore-finish" @click="finish(doing)"><span class="i-lucide-check mr-1" />做完了</van-button>
        </div>
      </div>

      <div class="mt-3"><Segmented v-model="tab" :options="doingTabs" /></div>

      <!-- 聊天 / 连麦 -->
      <div v-if="tab === 'talk'" class="mt-2.5" data-testid="chore-talk">
        <template v-if="!link.state.on">
          <div class="talk">
            <p v-for="(l, i) in talk.slice(-4)" :key="i" :class="l.who"><b>{{ l.who === 'her' ? her.name : '我' }}：</b>{{ l.text }}</p>
            <p v-if="stream && !streamingText" class="her"><b>{{ her.name }}：</b><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></p>
            <p v-if="!talk.length && !stream" class="text-ink-3">一边做一边跟{{ her.pronoun }}说点什么</p>
          </div>
          <form class="flex gap-2 mt-2" @submit.prevent="sendText">
            <input v-model="text" class="field" :placeholder="`和${her.pronoun}说点什么`" aria-label="边做边聊" enterkeyhint="send" />
            <button type="submit" class="round-btn" :disabled="!text.trim() || !!stream" aria-label="发送"><span class="i-lucide-send" /></button>
            <button type="button" class="round-btn accent" aria-label="连麦" data-testid="chore-mic" @click="link.connect()"><span class="i-lucide-headphones" /></button>
          </form>
          <p class="text-[11.5px] text-ink-3 mt-1.5 mb-0">点耳机和{{ her.pronoun }}连麦：手上忙着也能说话，{{ her.pronoun }}用自己的声音回你</p>
        </template>
        <template v-else>
          <div class="flex items-center gap-2">
            <span class="live-dot" />
            <span class="flex-1 min-w-0 truncate text-[13px] text-accent-ink">{{ linkStatus }}</span>
            <span class="num text-[12px] text-ink-3">{{ clock(link.state.seconds) }}</span>
          </div>
          <Waveform :level="link.state.her === 'speaking' ? level : link.state.muted ? 0 : link.state.youLevel" :tone="link.state.her === 'speaking' ? 'var(--accent)' : 'var(--ink-2)'" :bars="25" />
          <div class="talk">
            <p v-for="c in link.state.captions.slice(-3)" :key="c.id" :class="c.who"><b>{{ c.who === 'her' ? her.name : '我' }}：</b>{{ c.text }}</p>
            <p v-if="!link.state.captions.length" class="text-ink-3">{{ her.pronoun }}在听……</p>
          </div>
          <p v-if="linkIssue" class="text-[12.5px] text-bad mt-1.5 mb-0">{{ linkIssue }}</p>
          <button v-if="link.state.needTap && link.state.input !== 'type'" class="notice tap" @click="link.tapToListen()"><span class="i-lucide-mic" />浏览器要先点一下才能听你说话：点这里</button>
          <form v-if="link.state.input === 'type'" class="flex gap-2 mt-2" @submit.prevent="sendTyped">
            <input v-model="typed" class="field" :placeholder="`跟${her.pronoun}说……`" :aria-label="`跟${her.name}说`" enterkeyhint="send" />
            <van-button size="small" round native-type="submit" :disabled="!typed.trim()">说</van-button>
          </form>
          <div class="link-ctrls">
            <button class="lc" :class="{ on: link.state.muted }" :disabled="link.state.input === 'type'" @click="link.setMuted(!link.state.muted)">
              <span class="circle"><span :class="link.state.muted ? 'i-lucide-mic-off' : 'i-lucide-mic'" /></span>{{ link.state.muted ? '已闭麦' : '闭麦' }}
            </button>
            <button class="lc" @click="link.setInput(link.state.input === 'type' ? 'auto' : 'type')">
              <span class="circle"><span :class="link.state.input === 'type' ? 'i-lucide-audio-lines' : 'i-lucide-keyboard'" /></span>{{ link.state.input === 'type' ? '改成说话' : '打字' }}
            </button>
            <button class="lc hang" data-testid="chore-hangup" @click="link.hangUp()">
              <span class="circle"><span class="i-lucide-phone-off" /></span>挂断
            </button>
          </div>
        </template>
      </div>

      <!-- 音乐 -->
      <PlaylistMusic v-else-if="tab === 'music'" :player="choreMusic" :searches="CHORE_SEARCHES" test-id="chore-music" />

      <!-- 菜谱（做饭时，今天计划里的那一顿） -->
      <div v-else-if="mealFor(doing)" class="mt-2.5">
        <MealCard :meal="mealFor(doing)!.meal" :which="mealFor(doing)!.key" open />
      </div>
    </template>

    <!-- 今天的清单 -->
    <template v-else>
      <div class="flex items-end gap-2">
        <div class="flex-1 min-w-0">
          <div class="text-[16px] font-700">今天的家务</div>
          <div class="text-[12px] text-ink-3 mt-0.5">点"开始"做，做完打勾；也可以先拖着</div>
        </div>
        <span class="num text-[13px] text-accent-ink shrink-0" data-testid="home-progress">做完 {{ doneCount }} / {{ items.length }}</span>
      </div>
      <span class="bar" aria-hidden="true"><span :style="{ width: `${items.length ? Math.round((doneCount / items.length) * 100) : 0}%` }" /></span>

      <div v-if="allDone" class="all-done"><span class="i-lucide-party-popper text-accent-ink" />今天的家务都做完了</div>

      <div v-if="todo.length" class="list" data-testid="chore-list">
        <div v-for="it in todo" :key="it.key" class="row" :class="{ overdue: it.overdue, early: it.early }" :data-chore="it.label">
          <button type="button" class="check" :aria-label="`${it.label}：直接打勾`" @click="finish(it)"><span class="i-lucide-circle" /></button>
          <span class="chore-icon"><span :class="iconOf(it)" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[14.5px] truncate">{{ it.label }}</div>
            <div class="text-[11.5px] truncate" :class="it.overdue ? 'text-bad' : 'text-ink-3'">{{ subOf(it) }}</div>
          </div>
          <button type="button" class="mini" :disabled="!!stream" @click="procrastinate(it)">晚点</button>
          <button type="button" class="mini primary" data-testid="chore-start" @click="start(it)">开始</button>
        </div>
      </div>

      <template v-if="later.length">
        <div class="sub-title">拖着的</div>
        <div class="list">
          <div v-for="it in later" :key="it.key" class="row later" :data-chore="it.label">
            <button type="button" class="check" :aria-label="`${it.label}：直接打勾`" @click="finish(it)"><span class="i-lucide-circle-dashed" /></button>
            <span class="chore-icon"><span :class="iconOf(it)" /></span>
            <div class="flex-1 min-w-0">
              <div class="text-[14.5px] truncate">{{ it.label }}</div>
              <div class="text-[11.5px] text-warn truncate">{{ subOf(it) }}</div>
            </div>
            <button type="button" class="mini primary" @click="start(it)">现在做</button>
          </div>
        </div>
      </template>

      <template v-if="done.length">
        <button type="button" class="sub-title w-full" :aria-expanded="doneOpen" @click="doneOpen = !doneOpen">
          做完了 {{ done.length }} 件<span :class="doneOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="ml-auto" />
        </button>
        <div v-if="doneOpen" class="list">
          <div v-for="it in done" :key="it.key" class="row done" :data-chore="it.label">
            <button type="button" class="check on" :aria-label="`${it.label}：改回没做`" @click="undo(it)"><span class="i-lucide-circle-check" /></button>
            <span class="chore-icon"><span :class="iconOf(it)" /></span>
            <div class="flex-1 min-w-0">
              <div class="text-[14.5px] truncate line-through text-ink-3">{{ it.label }}</div>
              <div class="text-[11.5px] text-ink-3 truncate">{{ subOf(it) }}</div>
            </div>
          </div>
        </div>
      </template>

      <template v-if="meals.length">
        <button type="button" class="sub-title w-full" :aria-expanded="mealsOpen" @click="mealsOpen = !mealsOpen">
          <span class="i-lucide-chef-hat" />今天吃什么（健康计划）<span :class="mealsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="ml-auto" />
        </button>
        <div v-if="mealsOpen" class="grid gap-2">
          <MealCard v-for="m in meals" :key="m.key" :meal="m.meal" :which="m.key" />
        </div>
      </template>
    </template>
  </SceneShell>
</template>

<style scoped>
.pill-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 17px;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 7px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 12.5px;
  color: var(--ink-2);
}
.notice.tap {
  width: 100%;
  justify-content: center;
  margin-top: 8px;
  color: var(--accent-ink);
  border: 1px solid var(--accent-line);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 6px 4px 2px;
}
.bar {
  display: block;
  height: 5px;
  margin-top: 9px;
  border-radius: 3px;
  background: var(--panel-2);
  overflow: hidden;
}
.bar > span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.6s ease;
}
.all-done {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 13.5px;
}
.list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  margin-top: 10px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px 6px;
  border-radius: 14px;
  background: var(--panel);
}
.row.overdue {
  outline: 1px solid color-mix(in srgb, var(--bad) 40%, transparent);
}
.row.early {
  opacity: 0.72;
}
.check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  color: var(--ink-3);
  font-size: 21px;
}
.check.on {
  color: var(--good);
}
.chore-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: var(--surface);
  color: var(--accent-ink);
  font-size: 17px;
  flex-shrink: 0;
}
.chore-icon.big {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  font-size: 22px;
  background: var(--accent-soft);
}
.mini {
  flex-shrink: 0;
  height: 30px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--surface);
  color: var(--ink-2);
  font-size: 12.5px;
}
.mini.primary {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.mini:disabled {
  opacity: 0.5;
}
.sub-title {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.doing {
  padding: 12px;
  border-radius: 18px;
  background: var(--panel);
}
.talk {
  margin-top: 8px;
  max-height: 140px;
  overflow-y: auto;
  font-size: 13.5px;
  line-height: 1.6;
}
.talk p {
  margin: 3px 0;
}
.talk p.her b {
  color: var(--accent-ink);
}
.talk p.you {
  color: var(--ink-2);
}
.field {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 14px;
  border-radius: 19px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
}
.round-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 17px;
  flex-shrink: 0;
}
.round-btn.accent {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.round-btn:disabled {
  opacity: 0.5;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--good);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--good) 25%, transparent);
  flex-shrink: 0;
}
.link-ctrls {
  display: flex;
  justify-content: space-around;
  margin-top: 10px;
}
.lc {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-2);
}
.lc .circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--panel);
  font-size: 19px;
}
.lc.on .circle {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.lc.hang .circle {
  background: var(--bad);
  color: #fff;
}
.lc:disabled {
  opacity: 0.5;
}
</style>
