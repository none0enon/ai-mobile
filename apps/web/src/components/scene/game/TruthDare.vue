<script setup lang="ts">
import { expressionField, isTruthDarePreset, parseControlTags, presetLevels, TRUTH_DARE_LEVEL, type MessagePart, type PresetUseId, type TruthDareTally } from '@app/shared';
import { showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';

/**
 * 一起游戏 · 真心话大冒险（设计文档 §9.11）。
 * 开局转瓶子定谁先，之后轮流：
 * - 轮到你：你选真心话还是大冒险，她按尺度出题（JSON：题目 + 她的一句话）；你写下回答、做完了、换一个（每轮一次）或者认罚，她来反应；
 * - 轮到她：她选真心话还是大冒险，你出题（可以让模型帮你想几个），她回答、照着做。
 * 用"一起游戏 · 真心话大冒险"这个用途的预设（game-truthdare），每一步的规则都写在预设的块里，代码只填这一次的输入。
 * 尺度也在预设里：触发条件写了 td-level:名字 的块（TRUTH_DARE_LEVEL），开局时按块的顺序列出来，选了哪个每一步就只发那一块。
 * 每一步都存进聊天；"不玩了"时她说说这一局，发一张对局卡片。离开场景页时那一段写"一起玩了真心话大冒险（N 轮）"（GameScene 汇总）。
 */
type Choice = '真心话' | '大冒险';
type Who = 'you' | 'her';
export type TruthDarePhase = 'menu' | 'spin' | 'playing' | 'end';
interface Round {
  who: Who;
  /** 选了真心话还是大冒险；还没选时为空 */
  choice: Choice | null;
  /** 题目；还没出时为空 */
  card: string;
  /** 你的回答、做了什么，或者她的回答（截短：给之后出题、结束时说这一局用） */
  answer: string;
  /** 你认罚了 */
  skipped: boolean;
  /** 换过几次题（你那边每轮能换一次） */
  swaps: number;
  /** 这一轮完了：你答完、做完、认罚了，或者她答完了 */
  done: boolean;
}

const USE: PresetUseId = 'game-truthdare';
const CHOICES: Choice[] = ['真心话', '大冒险'];
const SWAPS = 1;
/** 上次选的尺度（只记在这台设备上，方便下次直接开始） */
const LEVEL_KEY = 'ai-mobile:truthdare-level';

const line = defineModel<string>('line', { required: true });
const phase = defineModel<TruthDarePhase>('phase', { required: true });
const emit = defineEmits<{
  fail: [r: { reason: string; notConnected?: boolean }];
  /** 这一局玩到哪了（离开时那一段的总结用）；还没玩完一轮时为空 */
  progress: [summary: string | null];
  /** 点了"不玩了"：这一局的总结 */
  done: [summary: string];
}>();

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

const rounds = ref<Round[]>([]);
const round = computed(() => rounds.value.at(-1));
/** 她在做什么：出题、选、想题、说话 */
const busy = ref<'' | 'card' | 'pick' | 'suggest' | 'reply'>('');
/** 你的回答 / 你给她出的题 */
const input = ref('');
/** 两轮之间你说的话 */
const talkText = ref('');
const suggestions = ref<string[]>([]);
const firstWho = ref<Who | null>(null);
const bottle = ref<HTMLElement | null>(null);
const presetOpen = ref(false);

const cue = computed(() => `第 ${rounds.value.length} 轮`);
const finished = computed(() => rounds.value.filter((r) => r.done));
const preset = computed(() => lib.presetForUse(USE, her.value));
/** 选的预设里有没有真心话大冒险的块（换成别的功能预设时出题、选择的格式会不对） */
const presetReady = computed(() => isTruthDarePreset(preset.value));
const tdFirst = (p: { name: string }) => p.name.includes('真心话');

/** 预设里的尺度，说明就是那一块的内容（开头的【…】标题不重复显示） */
const levels = computed(() =>
  presetLevels(preset.value, TRUTH_DARE_LEVEL).map(({ name, block }) => ({
    name,
    desc: block.content.replaceAll('{{user}}', userName.value).replaceAll('{{char}}', her.value.name).replace(/^【[^】]*】\s*/, '').trim(),
  })),
);
function savedLevel(): string {
  try {
    return localStorage.getItem(LEVEL_KEY) ?? '';
  } catch {
    return '';
  }
}
const picked = ref(savedLevel());
/** 开局前选中的尺度：上次选的还在预设里就用它，不然用预设里的第一个；预设里没有尺度时为空 */
const level = computed(() => levels.value.find((l) => l.name === picked.value)?.name ?? levels.value[0]?.name ?? '');
const levelDesc = computed(() => levels.value.find((l) => l.name === level.value)?.desc ?? '');
function pickLevel(name: string) {
  picked.value = name;
  try {
    localStorage.setItem(LEVEL_KEY, name);
  } catch {
    // 浏览器不让存：这次照样用，下次回到预设里的第一个
  }
}
/** 这一局的尺度：开局时定下，玩的时候不变 */
const gameLevel = ref('');
/** 这一局每一步都打开选的那个尺度的块 */
const levelFlags = computed(() => (gameLevel.value ? [`${TRUTH_DARE_LEVEL}${gameLevel.value}`] : []));

const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let alive = true;
const abort = new AbortController();
onBeforeUnmount(() => {
  alive = false;
  abort.abort();
});

function nameOf(who: Who): string {
  return who === 'you' ? userName.value : her.value.name;
}

/** 模型写的字：去掉混进来的控制标签，截到 max 个字 */
function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? parseControlTags(v, []).visible.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function expr(v: unknown): { expr?: string } {
  return expressionField(v, her.value.portraits);
}

function parseCard(v: unknown): { card: string; line: string; expr?: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const card = clean(o.card, 80);
  return card ? { card, line: clean(o.line, 40), ...expr(o.expr) } : null;
}

function parsePick(v: unknown): { choice: Choice; line: string; expr?: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  // 照抄了格式（"真心话|大冒险"）的不算选了
  const hits = CHOICES.filter((c) => String(o.pick ?? '').includes(c));
  return hits.length === 1 ? { choice: hits[0]!, line: clean(o.line, 40), ...expr(o.expr) } : null;
}

function parseOptions(v: unknown): string[] | null {
  const list = (v as { options?: unknown } | null)?.options;
  if (!Array.isArray(list)) return null;
  const out = [...new Set(list.map((x) => clean(x, 80)).filter(Boolean))].slice(0, 3);
  return out.length ? out : null;
}

/** 这一局一个人的数：做到了的真心话、大冒险，和认罚的次数 */
function tally(who: Who): TruthDareTally {
  const rs = finished.value.filter((r) => r.who === who);
  const t: TruthDareTally = { truth: rs.filter((r) => !r.skipped && r.choice === '真心话').length, dare: rs.filter((r) => !r.skipped && r.choice === '大冒险').length };
  const skipped = rs.filter((r) => r.skipped).length;
  return skipped ? { ...t, skipped } : t;
}

const togetherLine = computed(() => {
  const mode = chat.chatById(chatId.value)?.togetherMode;
  if (mode === 'visit') return `${userName.value}来你这边了，坐在你旁边`;
  if (mode === 'bring') return `你在${userName.value}这边`;
  return `连线（${userName.value}在自己那边，你在你那边）`;
});

/**
 * 这一次的输入，只放数据：怎么在一起、这一局出过的题（谁选了什么、怎么答的），加上这一步的情况。
 * 尺度不在这里：选的那个尺度的块按触发条件发送；每一步要她做什么写在预设那一步的块里
 */
function tdInput(extra: (string | false)[]): string {
  const past = rounds.value.filter((r) => r.card);
  return [
    `你们怎么在一起：${togetherLine.value}`,
    past.length
      ? `这一局出过的题：\n${past.map((r, i) => `${i + 1}. ${nameOf(r.who)}选了${r.choice}：${r.card}${r.skipped ? '（认罚了）' : r.answer ? ` → ${r.answer}` : ''}`).join('\n')}`
      : '这一局出过的题：还没有',
    ...extra,
  ]
    .filter(Boolean)
    .join('\n');
}

function say(role: 'user' | 'assistant' | 'narrator', text: string, extra: { expression?: string; agent?: boolean; cue?: string } = {}) {
  chat.push(chatId.value, role, [{ type: 'text', text }], {
    meta: { scene: 'game', cue: extra.cue ?? cue.value, ...(extra.agent ? { agent: 'companion' as const } : {}) },
    expression: extra.expression ?? null,
  });
  if (extra.expression) chars.setExpression(her.value.id, extra.expression);
}

function fail(r: { reason: string; notConnected?: boolean }) {
  if (alive) emit('fail', r);
}

function report() {
  emit('progress', finished.value.length ? `真心话大冒险（${finished.value.length} 轮）` : null);
}

/** 她说一段（反应、回答、做挑战、聊两句、结束时的话）：流式显示在她的那句话里，存进聊天 */
async function herReply(task: string, userText: string | undefined, extra: (string | false)[], replyCue?: string): Promise<boolean> {
  busy.value = 'reply';
  line.value = '';
  try {
    const r = await chat.sceneReply(chatId.value, {
      task,
      input: tdInput(extra),
      userText,
      cue: replyCue ?? cue.value,
      use: USE,
      flags: levelFlags.value,
      allowedTags: ['expr'],
      onText: (t) => {
        if (alive) line.value = t;
      },
    });
    if (!r.ok) {
      fail(r);
      return false;
    }
    if (alive) line.value = r.message.text;
    return true;
  } finally {
    busy.value = '';
  }
}

// —— 开局：转瓶子 ——
async function start() {
  if (!chatId.value) return;
  rounds.value = [];
  suggestions.value = [];
  input.value = '';
  talkText.value = '';
  line.value = '';
  gameLevel.value = level.value;
  report();
  const who: Who = Math.random() < 0.5 ? 'you' : 'her';
  firstWho.value = null;
  phase.value = 'spin';
  await nextTick();
  // 瓶口朝左是你，朝右是她；多转几圈，停得不那么正
  const end = (4 + Math.floor(Math.random() * 3)) * 360 + (who === 'you' ? 270 : 90) + (Math.random() * 24 - 12);
  const el = bottle.value;
  if (el && !reduceMotion && typeof el.animate === 'function') {
    await el
      .animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${end}deg)` }], { duration: 1900, easing: 'cubic-bezier(0.12, 0.7, 0.18, 1)', fill: 'forwards' })
      .finished.catch(() => undefined);
  } else if (el) {
    el.style.transform = `rotate(${end}deg)`;
  }
  if (!alive) return;
  firstWho.value = who;
  await sleep(reduceMotion ? 400 : 900);
  if (!alive || phase.value !== 'spin') return;
  chat.push(chatId.value, 'narrator', [{ type: 'text', text: `真心话大冒险${gameLevel.value ? `（${gameLevel.value}）` : ''}开始了，瓶子转到了${nameOf(who)}。` }], { meta: { scene: 'game', cue: '开局' } });
  nextRound(who);
}

function nextRound(who: Who) {
  rounds.value.push({ who, choice: null, card: '', answer: '', skipped: false, swaps: 0, done: false });
  input.value = '';
  talkText.value = '';
  suggestions.value = [];
  phase.value = 'playing';
  if (who === 'her') void herPick();
}

// —— 轮到你：选、她出题、你答 ——
async function youChoose(choice: Choice) {
  const r = round.value;
  if (!r || r.who !== 'you' || r.choice || busy.value) return;
  r.choice = choice;
  say('user', `我选${choice}！`);
  await herCard();
}

async function herCard(swap = false) {
  const r = round.value;
  if (!r?.choice || busy.value) return;
  if (swap) {
    if (r.swaps >= SWAPS || r.done) return;
    say('user', '换一个！');
  }
  busy.value = 'card';
  line.value = '';
  try {
    const res = await chat.sceneJson(
      chatId.value,
      {
        name: r.choice === '真心话' ? 'td-ask-truth' : 'td-ask-dare',
        input: tdInput([`这一轮：${userName.value}选了${r.choice}`, swap && `${userName.value}要换一题，换掉的是：${r.card}`]),
      },
      parseCard,
      abort.signal,
      { use: USE, flags: levelFlags.value },
    );
    if (!alive) return;
    if (!res.ok) return fail(res);
    if (swap) r.swaps += 1;
    r.card = res.value.card;
    input.value = '';
    line.value = res.value.line;
    say('assistant', `${res.value.line ? `${res.value.line}\n` : ''}【${r.choice}】${r.card}`, { expression: res.value.expr, agent: true });
  } finally {
    busy.value = '';
  }
}

async function youAnswer(kind: 'answer' | 'done' | 'skip') {
  const r = round.value;
  if (!r?.choice || !r.card || r.done || busy.value) return;
  const text = input.value.trim();
  if (kind === 'answer' && !text) return showToast('先写下你的回答');
  const verb = r.choice === '真心话' ? '答' : '做';
  const said = kind === 'skip' ? `这个我不敢${verb}……认罚` : kind === 'answer' ? text : text ? `做完了：${text}` : '做完了！';
  const result =
    kind === 'skip' ? `${userName.value}不敢${verb}，认罚了` : kind === 'answer' ? `${userName.value}的回答：${text}` : `${userName.value}做完了${text ? `：${text}` : '（没说具体怎么做的）'}`;
  r.skipped = kind === 'skip';
  r.answer = kind === 'skip' ? '' : (text || '做完了').slice(0, 80);
  r.done = true;
  input.value = '';
  report();
  await herReply('td-react', said, [`这一轮：${userName.value}选了${r.choice}`, `题目：${r.card}`, result]);
}

// —— 轮到她：她选、你出题、她答 ——
async function herPick() {
  const r = round.value;
  if (!r || r.who !== 'her' || r.choice || busy.value) return;
  busy.value = 'pick';
  line.value = '';
  try {
    const t = tally('her');
    const res = await chat.sceneJson(
      chatId.value,
      { name: 'td-pick', input: tdInput(['这一轮：轮到你', `你这一局选过：真心话 ${t.truth} 次、大冒险 ${t.dare} 次`]) },
      parsePick,
      abort.signal,
      { use: USE, flags: levelFlags.value, quick: true },
    );
    if (!alive) return;
    if (!res.ok) return fail(res);
    r.choice = res.value.choice;
    const text = res.value.line.includes(r.choice) ? res.value.line : `${r.choice}！${res.value.line}`;
    line.value = text;
    say('assistant', text, { expression: res.value.expr, agent: true });
  } finally {
    busy.value = '';
  }
}

async function suggest() {
  const r = round.value;
  if (!r?.choice || r.card || busy.value) return;
  busy.value = 'suggest';
  try {
    const res = await chat.sceneJson(
      chatId.value,
      { name: 'td-suggest', input: tdInput([`这一轮：${her.value.name}选了${r.choice}`]) },
      parseOptions,
      abort.signal,
      { use: USE, flags: levelFlags.value, quick: true },
    );
    if (!alive) return;
    if (!res.ok) return fail(res);
    suggestions.value = res.value;
  } finally {
    busy.value = '';
  }
}

function herTask(r: Round): string {
  return r.choice === '真心话' ? 'td-answer' : 'td-dare';
}

async function pose() {
  const r = round.value;
  const q = input.value.trim();
  if (!r?.choice || r.card || !q || busy.value) return;
  r.card = q.slice(0, 120);
  input.value = '';
  suggestions.value = [];
  await herAnswer(`【${r.choice}】${r.card}`);
}

/** 她回答、照着做；没接通、出错时题目已经在聊天里了，再试时不再发一遍 */
async function herAnswer(userText?: string) {
  const r = round.value;
  if (!r?.choice || !r.card || r.done || busy.value) return;
  const ok = await herReply(herTask(r), userText, [`这一轮：你选了${r.choice}`, `${userName.value}出的题：${r.card}`]);
  if (!ok || !alive) return;
  r.answer = clean(line.value, 80);
  r.done = true;
  report();
}

// —— 两轮之间 ——
async function talk() {
  const t = talkText.value.trim();
  const r = round.value;
  if (!t || !r || busy.value) return;
  talkText.value = '';
  await herReply('td-chat', t, [`现在：第 ${rounds.value.length} 轮刚结束，下一轮轮到${nameOf(r.who === 'you' ? 'her' : 'you')}`]);
}

// —— 不玩了：她说说这一局，发对局卡片 ——
async function end() {
  if (busy.value) return;
  const n = finished.value.length;
  if (!n) {
    rounds.value = [];
    phase.value = 'menu';
    line.value = '';
    report();
    return;
  }
  phase.value = 'end';
  // 先发卡片、记下这一局，再让她说：她说的时候你回聊天（离开了这件事），卡片也在"结束"那条前面
  const card: MessagePart = { type: 'game', logId: uid('game'), game: 'truthdare', ...(gameLevel.value ? { level: gameLevel.value } : {}), rounds: n, you: tally('you'), her: tally('her') };
  chat.postCard(chatId.value, 'user', card);
  emit('done', `真心话大冒险（${n} 轮）`);
  emit('progress', null);
  await herReply('td-end', undefined, [`这一局玩了 ${n} 轮，结束了`], '结束');
}

function again() {
  rounds.value = [];
  line.value = '';
  phase.value = 'menu';
}
</script>

<template>
  <!-- 开局前：尺度、预设 -->
  <template v-if="phase === 'menu'">
    <template v-if="levels.length">
      <div class="label !mt-0">尺度</div>
      <div class="flex flex-wrap gap-2">
        <button v-for="l in levels" :key="l.name" type="button" class="chip" :class="{ on: level === l.name }" :aria-pressed="level === l.name" @click="pickLevel(l.name)">{{ l.name }}</button>
      </div>
      <div class="level-desc">{{ levelDesc }}</div>
    </template>
    <p v-else-if="presetReady" class="warn !mt-0">这个预设里没有尺度：在预设里给一块填上"真心话大冒险的尺度"，开局时就能选。</p>
    <p class="rules">先转瓶子定谁先，之后轮流：轮到谁，谁选真心话还是大冒险，另一个人出题。不敢答、不敢做可以认罚。</p>
    <button type="button" class="preset-row press" @click="presetOpen = true">
      <span class="i-lucide-sliders-horizontal shrink-0 text-ink-3" />
      <span class="flex-1 min-w-0 text-left truncate">预设：{{ preset?.name ?? '没有功能预设' }}</span>
      <span class="text-accent-ink shrink-0">换</span>
    </button>
    <p v-if="!presetReady" class="warn">这个预设里没有真心话大冒险的块，出题、选择的格式可能不对；换成"一起游戏 · 真心话大冒险"或者从它复制一份。</p>
    <van-button type="primary" round block class="!mt-3" @click="start">转瓶子，开始</van-button>
  </template>

  <!-- 转瓶子 -->
  <div v-else-if="phase === 'spin'" class="spin" role="status" :aria-label="firstWho ? `瓶子转到了${firstWho === 'you' ? '你' : her.name}` : '瓶子在转'">
    <span class="side" :class="{ on: firstWho === 'you' }">你</span>
    <span class="dial"><span ref="bottle" class="bottle i-lucide-bottle-wine" /></span>
    <span class="side" :class="{ on: firstWho === 'her' }">{{ her.name }}</span>
    <div class="spin-note">{{ firstWho ? `转到了${firstWho === 'you' ? '你' : her.name}，${firstWho === 'you' ? '你' : her.pronoun}先来` : '瓶子在转…' }}</div>
  </div>

  <!-- 玩的时候 -->
  <template v-else-if="phase === 'playing' && round">
    <div class="flex items-center gap-2">
      <span class="text-[15px] font-600">{{ round.who === 'you' ? '轮到你' : `轮到${her.name}` }}</span>
      <span class="text-[12.5px] text-ink-3">第 {{ rounds.length }} 轮<template v-if="gameLevel"> · {{ gameLevel }}</template></span>
      <span class="flex-1" />
      <button type="button" class="quit" :disabled="!!busy" @click="end">不玩了</button>
    </div>

    <!-- 轮到你 -->
    <template v-if="round.who === 'you'">
      <div v-if="!round.choice" class="picks">
        <button type="button" class="pick truth press" :disabled="!!busy" @click="youChoose('真心话')"><span class="i-lucide-message-circle-heart" />真心话</button>
        <button type="button" class="pick dare press" :disabled="!!busy" @click="youChoose('大冒险')"><span class="i-lucide-flame" />大冒险</button>
      </div>
      <template v-else>
        <div class="card" :class="round.choice === '真心话' ? 'truth' : 'dare'">
          <span class="kind">{{ round.choice }}<template v-if="round.skipped"> · 认罚了</template></span>
          <div v-if="round.card" class="text">{{ round.card }}</div>
          <div v-else-if="busy === 'card'" class="thinking"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" />{{ her.pronoun }}在想题</div>
          <van-button v-else size="small" round class="!mt-1" @click="herCard()">让{{ her.pronoun }}出题</van-button>
        </div>
        <template v-if="round.card && !round.done">
          <textarea
            v-model="input"
            class="area mt-2"
            rows="2"
            :placeholder="round.choice === '真心话' ? '写下你的回答' : '做了什么（可以不写）'"
            :aria-label="round.choice === '真心话' ? '你的回答' : '做了什么'"
          />
          <div class="flex gap-2 mt-2 btns">
            <van-button v-if="round.choice === '真心话'" type="primary" size="small" round block :disabled="!!busy || !input.trim()" @click="youAnswer('answer')">回答</van-button>
            <van-button v-else type="primary" size="small" round block :disabled="!!busy" @click="youAnswer('done')">做完了</van-button>
            <van-button size="small" round block :loading="busy === 'card'" :disabled="!!busy || round.swaps >= SWAPS" @click="herCard(true)">换一个</van-button>
            <van-button size="small" round block :disabled="!!busy" @click="youAnswer('skip')">认罚</van-button>
          </div>
        </template>
      </template>
    </template>

    <!-- 轮到她 -->
    <template v-else>
      <div v-if="!round.choice" class="card">
        <div v-if="busy === 'pick'" class="thinking"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" />{{ her.pronoun }}在选</div>
        <van-button v-else size="small" round @click="herPick">让{{ her.pronoun }}选</van-button>
      </div>
      <template v-else>
        <div class="card" :class="round.choice === '真心话' ? 'truth' : 'dare'">
          <span class="kind">{{ her.pronoun }}选了{{ round.choice }}</span>
          <div v-if="round.card" class="text">{{ round.card }}</div>
          <div v-else class="text-[13px] text-ink-3 mt-1">{{ round.choice === '真心话' ? `问${her.pronoun}一个问题` : `给${her.pronoun}出一个挑战` }}</div>
        </div>
        <template v-if="!round.card">
          <button v-for="s in suggestions" :key="s" type="button" class="idea" @click="input = s">{{ s }}</button>
          <textarea
            v-model="input"
            class="area mt-2"
            rows="2"
            :placeholder="round.choice === '真心话' ? `问${her.pronoun}一个只能说真话的问题` : `${her.pronoun}现在就能做的事`"
            aria-label="你出的题"
          />
          <div class="flex gap-2 mt-2 btns">
            <van-button type="primary" size="small" round block :disabled="!!busy || !input.trim()" @click="pose">出题</van-button>
            <van-button size="small" round block :loading="busy === 'suggest'" :disabled="!!busy" @click="suggest">帮我想几个</van-button>
          </div>
        </template>
        <van-button v-else-if="!round.done && !busy" size="small" round block class="!mt-2" @click="herAnswer()">让{{ her.pronoun }}{{ round.choice === '真心话' ? '回答' : '做' }}</van-button>
      </template>
    </template>

    <!-- 一轮完了 -->
    <template v-if="round.done">
      <div class="flex gap-2 mt-2.5">
        <input v-model="talkText" class="field" placeholder="说点什么（追问、吐槽……）" aria-label="说点什么" @keydown.enter="(e: KeyboardEvent) => !e.isComposing && talk()" />
        <van-button size="small" round :disabled="!!busy || !talkText.trim()" @click="talk">说</van-button>
      </div>
      <van-button type="primary" round block class="!mt-2.5" :disabled="!!busy" @click="nextRound(round.who === 'you' ? 'her' : 'you')">
        下一轮：轮到{{ round.who === 'you' ? her.name : '你' }}
      </van-button>
    </template>
  </template>

  <!-- 这一局完了 -->
  <template v-else-if="phase === 'end'">
    <div class="text-[15px] font-600">真心话大冒险 · 玩了 {{ finished.length }} 轮</div>
    <div class="tally">
      你：真心话 {{ tally('you').truth }} · 大冒险 {{ tally('you').dare }}<template v-if="tally('you').skipped"> · 认罚 {{ tally('you').skipped }}</template>
    </div>
    <div class="tally">{{ her.name }}：真心话 {{ tally('her').truth }} · 大冒险 {{ tally('her').dare }}</div>
    <div class="text-[12.5px] text-ink-3 mt-1.5">{{ busy ? `${her.pronoun}在说这一局…` : '对局卡片已经发进聊天' }}</div>
    <div class="flex gap-2.5 mt-3">
      <van-button round block :disabled="!!busy" @click="again">再玩一局</van-button>
      <van-button type="primary" round block @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
    </div>
  </template>

  <!-- 放到 body 下：场景面板有 backdrop-filter，弹层留在里面会被关在面板里 -->
  <van-popup v-model:show="presetOpen" position="bottom" round teleport="body" :style="{ maxHeight: '80%' }">
    <div class="p-4">
      <div class="text-[15px] font-600">真心话大冒险用哪个预设</div>
      <p class="text-[12.5px] text-ink-3 mt-1 mb-3 leading-relaxed">
        出题、选真心话还是大冒险、回答、反应，每一步一块（「陪伴 · 快速」的模型）。尺度也是预设里的块：填了"真心话大冒险的尺度"的那几块按顺序列在开局前，改内容就改了这个尺度出什么样的题，加一块就多一个尺度。自带"一起游戏 · 真心话大冒险"，可以复制一份改。
      </p>
      <PresetPicker :model-value="lib.useChoice(USE)" category="feature" :first="tdFirst" @update:model-value="(id) => id && lib.setUse(USE, id)" />
    </div>
  </van-popup>
</template>

<style scoped>
.label {
  margin: 12px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.chip {
  height: 30px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.level-desc {
  display: -webkit-box;
  margin-top: 6px;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ink-3);
}
.rules {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-2);
}
.preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 10px;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 13px;
}
.warn {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn);
}
.spin {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
  padding: 6px 0 2px;
}
.side {
  justify-self: center;
  max-width: 100%;
  padding: 4px 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    background 0.2s,
    color 0.2s;
}
.side.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 600;
  outline: 1px solid var(--accent-line);
}
.dial {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 104px;
  height: 104px;
  border-radius: 50%;
  background: var(--panel);
  border: 1px dashed var(--border);
}
.bottle {
  font-size: 52px;
  color: var(--tint, var(--accent));
}
.spin-note {
  grid-column: 1 / -1;
  text-align: center;
  font-size: 13px;
  color: var(--ink-3);
}
.quit {
  flex-shrink: 0;
  padding: 4px 2px;
  font-size: 13px;
  color: var(--ink-3);
}
.quit:disabled {
  opacity: 0.5;
}
.picks {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 10px;
}
.pick {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 84px;
  border-radius: 18px;
  font-size: 16px;
  font-weight: 600;
  border: 1px solid var(--border);
  background: var(--panel);
}
.pick > span {
  font-size: 22px;
}
.pick.truth > span {
  color: #8fb3f0;
}
.pick.dare > span {
  color: #f08f7f;
}
.pick:disabled {
  opacity: 0.5;
}
.card {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.card.truth {
  background: color-mix(in srgb, #8fb3f0 14%, var(--panel));
  border-color: color-mix(in srgb, #8fb3f0 45%, transparent);
}
.card.dare {
  background: color-mix(in srgb, #f08f7f 14%, var(--panel));
  border-color: color-mix(in srgb, #f08f7f 45%, transparent);
}
.kind {
  font-size: 12px;
  color: var(--ink-3);
}
.text {
  margin-top: 4px;
  font-size: 15.5px;
  line-height: 1.6;
}
.thinking {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  font-size: 13px;
  color: var(--accent-ink);
}
.thinking .typing-dot:last-of-type {
  margin-right: 4px;
}
.idea {
  width: 100%;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  color: var(--accent-ink);
}
.area {
  width: 100%;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
  resize: none;
}
.field {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
}
.tally {
  margin-top: 6px;
  font-size: 13.5px;
  color: var(--ink-2);
}
.btns :deep(.van-button) {
  padding: 0 6px;
  white-space: nowrap;
}
</style>
