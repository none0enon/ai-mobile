<script setup lang="ts">
import { isFlightPreset, parseControlTags, type MessagePart, type PresetUseId } from '@app/shared';
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';

/**
 * 一起游戏 · 飞行棋（设计文档 §9.11）：双人，128 格，你和她轮流掷骰子（1–6），走到哪一格就做那一格的任务，先到终点的赢。
 * 棋盘就是"一起游戏 · 飞行棋"这个用途选的预设（棋盘预设，开始前在这里选）：开局时照它设计 128 格的任务
 * （fly-make：分四段一起发，哪一格走到了还没写好就等它、写不出来就单独再写），她走到的格子怎么做（fly-do）、
 * 你做完时她的反应（fly-react）、两回合之间聊两句（fly-chat）、结束时的话（fly-end），规则都写在预设里。
 * 格子的特殊效果（前进、后退、再掷一次、停一轮）也是模型照棋盘预设设计的；代码只管掷骰子、走棋、这一次的输入。
 * 每一格做了什么都存进聊天；"不玩了"或者有人到了终点时发一张对局卡片。
 */
type Who = 'you' | 'her';
export type FlightPhase = 'menu' | 'playing' | 'end';
interface Cell {
  n: number;
  task: string;
  /** 做完以后前进（正数）/ 后退（负数）几格 */
  move: number;
  /** 再掷一次 */
  again: boolean;
  /** 下一回合停一轮 */
  skip: boolean;
}

const USE: PresetUseId = 'game-flight';
/** 棋盘一共几格（游戏规则） */
const SIZE = 128;
/** 一次让模型设计几格（开局时四段一起发） */
const CHUNK = 32;
/** 棋盘一行几格（蛇形排） */
const COLS = 8;
const DICE = ['i-lucide-dice-1', 'i-lucide-dice-2', 'i-lucide-dice-3', 'i-lucide-dice-4', 'i-lucide-dice-5', 'i-lucide-dice-6'];

const line = defineModel<string>('line', { required: true });
const phase = defineModel<FlightPhase>('phase', { required: true });
const emit = defineEmits<{
  fail: [r: { reason: string; notConnected?: boolean }];
  /** 这一局下到哪了（离开时那一段的总结用）；还没掷过骰子时为空 */
  progress: [summary: string | null];
  /** 这一局完了：总结 */
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
const herMark = computed(() => her.value.name.slice(0, 1));

/** 棋盘预设：功能预设里有 fly- 开头触发条件的（自带的，和你复制、导入的） */
const boards = computed(() => lib.presetsOf('feature').filter((p) => isFlightPreset(p)));
const preset = computed(() => lib.presetForUse(USE, her.value));
const presetReady = computed(() => isFlightPreset(preset.value));

const cells = ref<(Cell | null)[]>([]);
const pos = reactive<Record<Who, number>>({ you: 0, her: 0 });
const skipNext = reactive<Record<Who, boolean>>({ you: false, her: false });
const turn = ref<Who>('you');
const step = ref<'roll' | 'task' | 'after'>('roll');
const dice = ref(0);
const rolling = ref(false);
/** 这一回合走到的格子（0 = 还没掷） */
const landed = ref(0);
const turns = ref(0);
const winner = ref<Who | null>(null);
const busy = ref(false);
const doneText = ref('');
const talkText = ref('');
const boardName = ref('');
/** 点开看的格子 */
const viewing = ref(0);
/** 这一格的效果执行完的说明（"前进 2 格，到第 39 格"） */
const effectNote = ref('');
/** 正在设计的那几次（显示进度） */
const designingJobs = ref(0);
const boardEl = ref<HTMLElement | null>(null);
/** 格子上写了"再掷一次"：下一回合还是这个人 */
const againWho = ref<Who | null>(null);

const cue = computed(() => `第 ${turns.value} 回合`);
const designed = computed(() => cells.value.filter(Boolean).length);
const landedCell = computed(() => (landed.value ? (cells.value[landed.value - 1] ?? null) : null));
const viewingCell = computed(() => (viewing.value ? (cells.value[viewing.value - 1] ?? null) : null));
const nextWho = computed<Who>(() => againWho.value ?? (turn.value === 'you' ? 'her' : 'you'));
/** 蛇形棋盘：第一行 1→8，第二行 16←9…… */
const rows = Array.from({ length: SIZE / COLS }, (_, r) => Array.from({ length: COLS }, (_, c) => r * COLS + (r % 2 === 0 ? c + 1 : COLS - c)));

const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let alive = true;
/** 这一局的设计请求：不玩了、重新开局、离开时取消 */
let gameAbort = new AbortController();
onBeforeUnmount(() => {
  alive = false;
  gameAbort.abort();
});

function nameOf(who: Who): string {
  return who === 'you' ? userName.value : her.value.name;
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? parseControlTags(v, []).visible.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** 格子的效果："前进 2 格，再掷一次" */
function effectOf(c: Cell): string {
  return [c.move > 0 ? `前进 ${c.move} 格` : c.move < 0 ? `后退 ${-c.move} 格` : '', c.again ? '再掷一次' : '', c.skip ? '停一轮' : ''].filter(Boolean).join('，');
}
/** 棋盘上格子角落的小标记 */
function effectMark(c: Cell | null): string {
  if (!c) return '';
  if (c.move) return c.move > 0 ? `+${c.move}` : `${c.move}`;
  return c.again ? '↻' : c.skip ? '停' : '';
}

function parseCells(nums: number[]) {
  const allowed = new Set(nums);
  return (v: unknown): Cell[] | null => {
    const list = (v as { cells?: unknown } | null)?.cells;
    if (!Array.isArray(list)) return null;
    const out: Cell[] = [];
    for (const x of list) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const n = Math.round(Number(o.n));
      const task = clean(o.task, 80);
      if (!allowed.has(n) || !task || out.some((c) => c.n === n)) continue;
      out.push({ n, task, move: Math.max(-6, Math.min(6, Math.round(Number(o.move) || 0))), again: o.again === true, skip: o.skip === true });
    }
    return out.length ? out : null;
  };
}

const togetherLine = computed(() => {
  const mode = chat.chatById(chatId.value)?.togetherMode;
  if (mode === 'visit') return `${userName.value}来你这边了，坐在你旁边`;
  if (mode === 'bring') return `你在${userName.value}这边`;
  return `连线（${userName.value}在自己那边，你在你那边）`;
});

/** 这一次的输入，只放数据：怎么在一起、棋盘和你们各走到哪，加上这一步的情况 */
function stateInput(extra: (string | false)[]): string {
  return [`你们怎么在一起：${togetherLine.value}`, `棋盘「${boardName.value}」一共 ${SIZE} 格：${userName.value}在第 ${pos.you} 格，${her.value.name}在第 ${pos.her} 格`, ...extra]
    .filter(Boolean)
    .join('\n');
}
function cellLines(n: number): string[] {
  const c = cells.value[n - 1];
  return [`这一格：第 ${n} 格`, c ? `任务：${c.task}` : '', c && effectOf(c) ? `效果：${effectOf(c)}` : ''];
}

// —— 设计格子：照棋盘预设的"棋盘设计"那一块 ——
const pending = new Map<number, Promise<void>>();
function design(nums: number[]): Promise<void> {
  const todo = nums.filter((n) => !cells.value[n - 1] && !pending.has(n));
  if (!todo.length) return Promise.all(nums.map((n) => pending.get(n))).then(() => undefined);
  const contiguous = todo.every((n, i) => i === 0 || n === todo[i - 1]! + 1);
  const which = contiguous && todo.length > 1 ? `第 ${todo[0]}–${todo.at(-1)} 格` : `第 ${todo.join('、')} 格`;
  designingJobs.value += 1;
  const signal = gameAbort.signal;
  const job = (async () => {
    try {
      const res = await chat.sceneJson(
        chatId.value,
        { name: 'fly-make', input: [`你们怎么在一起：${togetherLine.value}`, `棋盘一共 ${SIZE} 格；这一次设计：${which}`].join('\n') },
        parseCells(todo),
        signal,
        { use: USE, minTokens: 4096 },
      );
      if (!alive || signal.aborted) return;
      if (!res.ok) return void fail(res);
      for (const c of res.value) cells.value[c.n - 1] = c;
    } finally {
      designingJobs.value -= 1;
      for (const n of todo) pending.delete(n);
    }
  })();
  for (const n of todo) pending.set(n, job);
  return job;
}
/** 走到的格子：在设计就等它，没写出来就单独再写一次 */
async function ensureCell(n: number): Promise<Cell | null> {
  if (!cells.value[n - 1]) await pending.get(n);
  if (!cells.value[n - 1] && alive) await design([n]);
  return cells.value[n - 1] ?? null;
}

function fail(r: { reason: string; notConnected?: boolean }) {
  if (alive) emit('fail', r);
}

function summary(): string {
  return `飞行棋「${boardName.value}」（掷了 ${turns.value} 次${winner.value ? `，${nameOf(winner.value)}先到终点` : ''}）`;
}
function report() {
  emit('progress', turns.value ? summary() : null);
}

function narrate(text: string) {
  chat.push(chatId.value, 'narrator', [{ type: 'text', text }], { meta: { scene: 'game', cue: cue.value } });
}

/** 她说一段（做格子的任务、反应、聊两句、结束时的话）：流式显示在她的那句话里，存进聊天 */
async function herReply(task: string, userText: string | undefined, extra: (string | false)[]): Promise<boolean> {
  busy.value = true;
  line.value = '';
  try {
    const r = await chat.sceneReply(chatId.value, {
      task,
      input: stateInput(extra),
      userText,
      cue: cue.value,
      use: USE,
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
    busy.value = false;
  }
}

function scrollTo(n: number) {
  boardEl.value?.querySelector(`[data-n="${n}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}

// —— 开局 ——
function start() {
  if (!chatId.value) return;
  boardName.value = preset.value?.name ?? '飞行棋';
  gameAbort.abort();
  gameAbort = new AbortController();
  cells.value = Array.from({ length: SIZE }, () => null);
  pending.clear();
  Object.assign(pos, { you: 0, her: 0 });
  Object.assign(skipNext, { you: false, her: false });
  againWho.value = null;
  turn.value = 'you';
  step.value = 'roll';
  dice.value = 0;
  landed.value = 0;
  turns.value = 0;
  winner.value = null;
  viewing.value = 0;
  effectNote.value = '';
  line.value = '';
  phase.value = 'playing';
  report();
  chat.push(chatId.value, 'narrator', [{ type: 'text', text: `飞行棋开始了：棋盘「${boardName.value}」，一共 ${SIZE} 格，${userName.value}先掷。` }], {
    meta: { scene: 'game', cue: '开局' },
  });
  for (let from = 1; from <= SIZE; from += CHUNK) void design(Array.from({ length: Math.min(CHUNK, SIZE - from + 1) }, (_, i) => from + i));
}

// —— 掷骰子、走棋 ——
async function roll() {
  if (phase.value !== 'playing' || step.value !== 'roll' || rolling.value || busy.value || winner.value) return;
  const who = turn.value;
  rolling.value = true;
  line.value = '';
  viewing.value = 0;
  effectNote.value = '';
  for (let i = 0; i < (reduceMotion ? 1 : 7); i += 1) {
    dice.value = 1 + Math.floor(Math.random() * 6);
    await sleep(70);
  }
  const d = 1 + Math.floor(Math.random() * 6);
  dice.value = d;
  turns.value += 1;
  const to = Math.min(SIZE, pos[who] + d);
  while (pos[who] < to) {
    pos[who] += 1;
    scrollTo(pos[who]);
    await sleep(reduceMotion ? 0 : 120);
    if (!alive) return;
  }
  rolling.value = false;
  landed.value = to;
  step.value = 'task';
  report();
  await present(d);
}

/** 走到的格子：等它设计好，记进聊天；轮到她就让她做 */
async function present(d = dice.value) {
  const who = turn.value;
  const n = landed.value;
  busy.value = true;
  const cell = await ensureCell(n);
  busy.value = false;
  if (!alive || !cell) return;
  narrate(`${nameOf(who)}掷出 ${d}，走到第 ${n} 格：${cell.task}${effectOf(cell) ? `（${effectOf(cell)}）` : ''}`);
  if (who === 'her') {
    await herReply('fly-do', undefined, cellLines(n));
    applyEffects('her', cell);
  }
}

async function youDo(kind: 'done' | 'skip') {
  const n = landed.value;
  const c = landedCell.value;
  if (turn.value !== 'you' || step.value !== 'task' || !c || busy.value) return;
  const text = doneText.value.trim();
  doneText.value = '';
  const said = kind === 'skip' ? '这一格我跳过……' : text ? `做完了：${text}` : '做完了！';
  const result = kind === 'skip' ? `${userName.value}没做，跳过了` : `${userName.value}做完了${text ? `：${text}` : ''}`;
  step.value = 'after';
  await herReply('fly-react', said, [...cellLines(n), result]);
  applyEffects('you', c);
}

/** 做完这一格：执行格子的效果，看有没有人到终点 */
function applyEffects(who: Who, c: Cell) {
  const notes: string[] = [];
  // 走到最后一格就是到了终点，这一格的效果不算
  if (landed.value >= SIZE) {
    winner.value = who;
    step.value = 'after';
    report();
    return;
  }
  if (c.move) {
    const before = pos[who];
    pos[who] = Math.max(0, Math.min(SIZE, pos[who] + c.move));
    if (pos[who] !== before) {
      notes.push(`${c.move > 0 ? '前进' : '后退'} ${Math.abs(pos[who] - before)} 格，到第 ${pos[who]} 格`);
      scrollTo(pos[who]);
    }
  }
  if (c.again) {
    againWho.value = who;
    notes.push('再掷一次');
  }
  if (c.skip) {
    skipNext[who] = true;
    notes.push('下一回合停一轮');
  }
  if (pos[who] >= SIZE) winner.value = who;
  if (notes.length && alive) {
    effectNote.value = `${nameOf(who)}${notes.join('，')}`;
    narrate(effectNote.value);
  }
  step.value = 'after';
  report();
}

function nextTurn() {
  if (busy.value || rolling.value || step.value !== 'after') return;
  if (winner.value) return void end();
  let who = nextWho.value;
  againWho.value = null;
  if (skipNext[who]) {
    skipNext[who] = false;
    narrate(`${nameOf(who)}停一轮`);
    who = who === 'you' ? 'her' : 'you';
  }
  turn.value = who;
  step.value = 'roll';
  landed.value = 0;
  dice.value = 0;
  viewing.value = 0;
  effectNote.value = '';
  if (who === 'her') void roll();
}

async function talk() {
  const t = talkText.value.trim();
  if (!t || busy.value) return;
  talkText.value = '';
  await herReply('fly-chat', t, [`现在：第 ${turns.value} 回合刚结束，下一回合轮到${nameOf(nextWho.value)}`]);
}

// —— 不玩了 / 有人到了终点：发对局卡片，她说说这一局 ——
async function end() {
  if (busy.value || rolling.value) return;
  if (!turns.value) {
    phase.value = 'menu';
    line.value = '';
    report();
    return;
  }
  phase.value = 'end';
  gameAbort.abort();
  const card: MessagePart = { type: 'game', logId: uid('game'), game: 'flight', board: boardName.value, turns: turns.value, you: pos.you, her: pos.her, size: SIZE, ...(winner.value ? { winner: winner.value } : {}) };
  chat.postCard(chatId.value, 'user', card);
  emit('done', summary());
  emit('progress', null);
  await herReply('fly-end', undefined, [winner.value ? `结果：${nameOf(winner.value)}先到了终点` : '结果：没下完，不玩了']);
}

function again() {
  line.value = '';
  phase.value = 'menu';
}
</script>

<template>
  <!-- 开始前：选棋盘 -->
  <template v-if="phase === 'menu'">
    <div class="label !mt-0">棋盘</div>
    <div class="grid gap-2" role="radiogroup" aria-label="棋盘预设">
      <div v-for="p in boards" :key="p.id" class="board-pick" :class="{ on: preset?.id === p.id }">
        <button type="button" role="radio" :aria-checked="preset?.id === p.id" class="main" @click="lib.setUse(USE, p.id)">
          <span class="dot"><span v-if="preset?.id === p.id" class="i-lucide-check" /></span>
          <span class="flex-1 min-w-0">
            <span class="block text-[14px] font-600 truncate">{{ p.name }}</span>
            <span v-if="p.description" class="block text-[12px] text-ink-3 leading-normal mt-0.5 line-clamp-2">{{ p.description }}</span>
          </span>
        </button>
        <RouterLink :to="`/me/presets/${p.id}`" class="edit" :aria-label="`编辑棋盘「${p.name}」`">编辑</RouterLink>
      </div>
    </div>
    <p v-if="!boards.length" class="warn">还没有棋盘预设：在"我的 → 预设"里导入一个，或者恢复自带的"飞行棋 · 甜蜜日常"。</p>
    <p v-else-if="!presetReady" class="warn">现在用的预设不是棋盘，点一张棋盘换过来。</p>
    <p class="rules">一共 {{ SIZE }} 格，你和{{ her.pronoun }}轮流掷骰子（1–6），走到哪一格就做那一格的任务，先到终点的赢。格子是开局时照选的棋盘现设计的；想要自己的棋盘，复制一张改"棋盘设计"那一块。</p>
    <van-button type="primary" round block class="!mt-3" :disabled="!presetReady" @click="start">开始</van-button>
  </template>

  <!-- 下棋 -->
  <template v-else-if="phase === 'playing'">
    <div class="flex items-center gap-2">
      <span class="text-[15px] font-600">{{ turn === 'you' ? '轮到你' : `轮到${her.name}` }}</span>
      <span class="text-[12.5px] text-ink-3 num">你 {{ pos.you }} · {{ her.pronoun }} {{ pos.her }} / {{ SIZE }}</span>
      <span class="flex-1" />
      <button type="button" class="quit" :disabled="busy || rolling" @click="end">不玩了</button>
    </div>
    <div v-if="designingJobs && designed < SIZE" class="making"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" />棋盘设计中 {{ designed }} / {{ SIZE }}</div>

    <div class="card">
      <span class="die" :class="[dice ? DICE[dice - 1] : 'i-lucide-dice-5', { rolling }]" aria-hidden="true" />
      <div class="flex-1 min-w-0">
        <template v-if="landed && landedCell">
          <div class="kind">第 {{ landed }} 格<template v-if="effectOf(landedCell)"> · {{ effectOf(landedCell) }}</template></div>
          <div class="text">{{ landedCell.task }}</div>
        </template>
        <div v-else-if="landed && busy" class="kind">第 {{ landed }} 格还在设计…</div>
        <div v-else-if="landed" class="kind">
          第 {{ landed }} 格没设计好
          <button type="button" class="retry" @click="present()">再设计一次</button>
        </div>
        <div v-else class="kind">{{ turn === 'you' ? '掷骰子，走到哪一格就做那一格的任务' : `${her.pronoun}在掷骰子…` }}</div>
        <div v-if="effectNote" class="effect">{{ effectNote }}</div>
      </div>
    </div>

    <van-button v-if="step === 'roll' && turn === 'you'" type="primary" round block class="!mt-2.5" :loading="rolling" :disabled="busy" @click="roll">掷骰子</van-button>
    <template v-else-if="step === 'task' && turn === 'you' && landedCell">
      <textarea v-model="doneText" class="area mt-2" rows="2" placeholder="做了什么（可以不写）" aria-label="做了什么" />
      <div class="flex gap-2 mt-2 btns">
        <van-button type="primary" size="small" round block :disabled="busy" @click="youDo('done')">做完了</van-button>
        <van-button size="small" round block :disabled="busy" @click="youDo('skip')">跳过</van-button>
      </div>
    </template>
    <template v-else-if="step === 'after'">
      <div class="flex gap-2 mt-2.5">
        <input v-model="talkText" class="field" placeholder="说点什么" aria-label="说点什么" @keydown.enter="(e: KeyboardEvent) => !e.isComposing && talk()" />
        <van-button size="small" round :disabled="busy || !talkText.trim()" @click="talk">说</van-button>
      </div>
      <van-button type="primary" round block class="!mt-2.5" :disabled="busy" @click="nextTurn">
        {{ winner ? '看结果' : `下一回合：轮到${nextWho === 'you' ? '你' : her.name}` }}
      </van-button>
    </template>

    <div class="board-head">
      <span>起点</span>
      <span v-if="pos.you === 0" class="piece you">你</span>
      <span v-if="pos.her === 0" class="piece her">{{ herMark }}</span>
      <span class="flex-1" />
      <span class="text-ink-3">点一格看任务</span>
    </div>
    <div ref="boardEl" class="board">
      <div v-for="(row, r) in rows" :key="r" class="board-row">
        <button
          v-for="n in row"
          :key="n"
          type="button"
          class="cell"
          :data-n="n"
          :class="{ ready: !!cells[n - 1], special: !!effectMark(cells[n - 1] ?? null), landed: n === landed, viewing: n === viewing, goal: n === SIZE }"
          :aria-label="`第 ${n} 格${cells[n - 1] ? `：${cells[n - 1]!.task}` : '（还没设计好）'}`"
          @click="viewing = viewing === n ? 0 : n"
        >
          <span class="num">{{ n === SIZE ? '终' : n }}</span>
          <span v-if="effectMark(cells[n - 1] ?? null)" class="mark">{{ effectMark(cells[n - 1] ?? null) }}</span>
          <span class="pieces">
            <span v-if="pos.you === n" class="piece you">你</span>
            <span v-if="pos.her === n" class="piece her">{{ herMark }}</span>
          </span>
        </button>
      </div>
    </div>
    <div v-if="viewing" class="peek">
      第 {{ viewing }} 格：{{ viewingCell ? viewingCell.task : '还没设计好' }}<template v-if="viewingCell && effectOf(viewingCell)">（{{ effectOf(viewingCell) }}）</template>
    </div>
  </template>

  <!-- 这一局完了 -->
  <template v-else-if="phase === 'end'">
    <div class="text-[15px] font-600">飞行棋 · {{ winner ? `${winner === 'you' ? '你' : her.name}先到终点` : '没下完' }}</div>
    <div class="tally">棋盘「{{ boardName }}」· 掷了 {{ turns }} 次骰子</div>
    <div class="tally">你走到第 {{ pos.you }} 格 · {{ her.name }}走到第 {{ pos.her }} 格</div>
    <div class="text-[12.5px] text-ink-3 mt-1.5">{{ busy ? `${her.pronoun}在说这一局…` : '对局卡片已经发进聊天' }}</div>
    <div class="flex gap-2.5 mt-3">
      <van-button round block :disabled="busy" @click="again">再来一局</van-button>
      <van-button type="primary" round block @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
    </div>
  </template>
</template>

<style scoped>
.label {
  margin: 12px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.board-pick {
  display: flex;
  align-items: stretch;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid transparent;
}
.board-pick.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.board-pick .main {
  display: flex;
  flex: 1;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 10px 0 10px 12px;
  text-align: left;
}
.board-pick .dot {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  border: 1.5px solid var(--ink-3);
  font-size: 13px;
}
.board-pick.on .dot {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.board-pick .edit {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  padding: 0 14px;
  color: var(--accent-ink);
  font-size: 13px;
  text-decoration: none;
}
.warn {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn);
}
.rules {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-2);
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
.making {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--accent-ink);
}
.making .typing-dot:last-of-type {
  margin-right: 4px;
}
.card {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.die {
  font-size: 40px;
  color: var(--tint, var(--accent));
}
.die.rolling {
  animation: wobble 0.28s ease-in-out infinite;
}
@keyframes wobble {
  50% {
    transform: rotate(18deg) scale(1.08);
  }
}
.kind {
  font-size: 12.5px;
  color: var(--ink-3);
}
.text {
  margin-top: 3px;
  font-size: 15px;
  line-height: 1.55;
}
.effect {
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--accent-ink);
}
.retry {
  margin-left: 6px;
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
.btns :deep(.van-button) {
  padding: 0 6px;
  white-space: nowrap;
}
.board-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--ink-2);
}
.board {
  display: grid;
  gap: 4px;
  max-height: 232px;
  margin-top: 6px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.board-row {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 4px;
}
.cell {
  position: relative;
  aspect-ratio: 1;
  min-width: 0;
  border-radius: 9px;
  background: var(--panel);
  border: 1px dashed var(--border);
  color: var(--ink-3);
  font-size: 11px;
}
.cell.ready {
  border-style: solid;
  color: var(--ink-2);
}
.cell.special {
  background: var(--accent-soft);
}
.cell.goal {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 600;
}
.cell.landed {
  outline: 2px solid var(--accent);
}
.cell.viewing {
  outline: 2px dashed var(--accent-line);
}
.cell .num {
  position: absolute;
  top: 3px;
  left: 4px;
}
.cell .mark {
  position: absolute;
  top: 3px;
  right: 4px;
  font-size: 10px;
  color: var(--accent-ink);
}
.cell .pieces {
  position: absolute;
  bottom: 3px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  gap: 2px;
}
.piece {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 3px;
  border-radius: 9px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1;
}
.piece.you {
  background: var(--accent);
  color: var(--on-accent);
}
.piece.her {
  background: var(--tint, #b9a3e6);
  color: #fff;
}
.peek {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 13px;
  line-height: 1.55;
}
.tally {
  margin-top: 6px;
  font-size: 13.5px;
  color: var(--ink-2);
}
</style>
