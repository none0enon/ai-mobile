<script setup lang="ts">
import { isExpression, worldOf, type MessagePart } from '@app/shared';
import { showToast } from 'vant';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import TruthDare, { type TruthDarePhase } from '@/components/scene/game/TruthDare.vue';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { parseSoup, useSoupStore, type Soup } from '@/stores/soups';
import { uid } from '@/utils/id';

/**
 * 一起游戏（设计文档 §9.11）：海龟汤（这个文件）和真心话大冒险（components/scene/game/TruthDare.vue），开始前在最上面切换。
 * 海龟汤：
 * - 她出题你猜：她当主持人，知道汤底，按汤底答"是 / 不是 / 无关 / 是也不是"，偶尔逗你一句（检查过不泄底）；
 * - 一起猜：中立的主持人判定，她是你的队友，她那边的调用里没有汤底，所以她真的不知道；
 * - 你出题她猜：你写汤面（汤底可写可不写），她来问，你点按钮回答。
 * 每一问每一答都存进聊天；汤底揭晓后才存进去。规则、判定格式都在"一起游戏 · 海龟汤"功能预设里，代码只填这一次的输入。
 * 一局玩完不结束这件事（还能再来一局、换个游戏）：离开场景页时那一段写这一次玩了哪几局。
 */
type Game = 'soup' | 'truthdare';
const GAMES: { value: Game; label: string }[] = [
  { value: 'soup', label: '海龟汤' },
  { value: 'truthdare', label: '真心话大冒险' },
];
type Mode = 'host' | 'coop' | 'guest';
type Phase = 'menu' | 'playing' | 'reveal';
const MODES: { id: Mode; label: string; desc: string }[] = [
  { id: 'host', label: '她出题', desc: '你问是非题，她答' },
  { id: 'coop', label: '一起猜', desc: '主持人判定，她和你一起想' },
  { id: 'guest', label: '你出题', desc: '你写汤面，她来猜' },
];
const ANSWERS = ['是', '不是', '无关', '是也不是'] as const;
type Answer = (typeof ANSWERS)[number];

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const soupStore = useSoupStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

const phase = ref<Phase>('menu');
const mode = ref<Mode>('host');
const allowRed = ref(false);
const soup = ref<Soup | null>(null);
const qa = ref<{ q: string; a: string; by: 'you' | 'her' }[]>([]);
const hit = ref<number[]>([]);
const close = ref(false);
const hints = ref(0);
const result = ref<'solved' | 'partial' | 'gave-up' | null>(null);
const herLine = ref('');
const herIdea = ref('');
const busy = ref(false);
const notConnected = ref('');
const input = ref('');
const answerOpen = ref(false);
const answerText = ref('');
// 你出题
const mySurface = ref('');
const myTruth = ref('');
const herQuestion = ref('');
const herGuess = ref('');

const game = ref<Game>('soup');
const tdPhase = ref<TruthDarePhase>('menu');
/** 开始前才能换游戏 */
const choosing = computed(() => (game.value === 'soup' ? phase.value === 'menu' : tdPhase.value === 'menu'));
watch(game, () => {
  herLine.value = '';
});
/** 这一次玩完的几局，和正在玩的真心话大冒险：离开时那一段写"一起玩了…" */
const played = ref<string[]>([]);
const tdProgress = ref<string | null>(null);
onMounted(() => {
  chat.setLeaveSummary(her.value.id, () => {
    const all = [...played.value, ...(tdProgress.value ? [tdProgress.value] : [])];
    return all.length ? `一起玩了${all.join('、')}` : undefined;
  });
});
onBeforeUnmount(() => {
  // 离开时那一段的总结已经在离开前取走了（ScenePage 的 onBeforeRouteLeave）
  chat.setLeaveSummary(her.value.id, null);
});

const list = computed(() => soupStore.soups.filter((s) => allowRed.value || s.kind === '清汤'));
const cue = computed(() => `第 ${qa.value.length + 1} 问`);
const replying = computed(() => !!chat.streams[chatId.value]);

function fail(r: { reason: string; notConnected?: boolean }) {
  if (r.notConnected) notConnected.value = r.reason;
  else showToast(r.reason);
}

/** 这一次的输入：汤面、（主持人才有的）汤底和关键点、之前的问答 */
function soupInput(withTruth: boolean, extra: string[] = []): string {
  const s = soup.value!;
  return [
    `海龟汤《${s.title}》`,
    `汤面：${s.surface}`,
    withTruth && s.truth ? `汤底：${s.truth}` : '',
    withTruth && s.keys.length ? `关键点：\n${s.keys.map((k, i) => `${i + 1}. ${k}`).join('\n')}` : '',
    qa.value.length ? `之前的问答：\n${qa.value.map((x, i) => `${i + 1}. ${x.by === 'her' ? her.value.name : userName.value}问：${x.q} 答：${x.a}`).join('\n')}` : '之前的问答：还没有',
    ...extra,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 她那句话和汤底有连续 6 个字一样，就当泄底，不显示 */
function leaks(line: string): boolean {
  const a = line.replace(/\s/g, '');
  const b = (soup.value?.truth ?? '').replace(/\s/g, '');
  for (let i = 0; i + 6 <= a.length; i += 1) if (b.includes(a.slice(i, i + 6))) return true;
  return false;
}

function say(role: 'user' | 'assistant' | 'narrator', text: string, extra: { expression?: string | null; agent?: boolean } = {}) {
  chat.push(chatId.value, role, [{ type: 'text', text }], { meta: { scene: 'game', cue: cue.value, ...(extra.agent ? { agent: 'companion' as const } : {}) }, expression: extra.expression ?? null });
}

// —— 开始 ——
function begin(s: Soup) {
  soup.value = s;
  qa.value = [];
  hit.value = [];
  hints.value = 0;
  close.value = false;
  result.value = null;
  herLine.value = '';
  herIdea.value = '';
  phase.value = 'playing';
  chat.push(chatId.value, 'narrator', [{ type: 'text', text: `海龟汤《${s.title}》（${MODES.find((m) => m.id === mode.value)?.label}）：${s.surface}` }], { meta: { scene: 'game', cue: '开局' } });
  if (mode.value === 'guest') void herTurn();
}
function beginMine() {
  const surface = mySurface.value.trim();
  if (!surface) return showToast('先写汤面');
  begin({ id: uid('soup'), title: surface.slice(0, 12), surface, truth: myTruth.value.trim(), keys: [], difficulty: 1, kind: '清汤', origin: 'mine' });
}

// —— 现编一道：先写汤底和汤面，再自检 ——
async function makeOne() {
  if (busy.value || !chatId.value) return;
  busy.value = true;
  try {
    const places = worldOf(her.value.id).locations.map((l) => l.name).join('、');
    const made = await chat.sceneJson(chatId.value, { name: 'soup-make', input: [`尺度：${allowRed.value ? '清汤或红汤都可以（红汤也不写血腥细节）' : '清汤'}`, `可以用的地点：${places}`].join('\n') }, parseSoup);
    if (!made.ok) return fail(made);
    const check = await chat.sceneJson(chatId.value, { name: 'soup-check', input: JSON.stringify({ surface: made.value.surface, truth: made.value.truth, keys: made.value.keys }) }, (v) =>
      v && typeof v === 'object' && typeof (v as { ok?: unknown }).ok === 'boolean' ? (v as { ok: boolean; reason?: string }) : null,
    );
    if (!check.ok) return fail(check);
    if (!check.value.ok) return showToast(`这道没通过自检：${check.value.reason ?? ''}，再编一道试试`);
    const { id: _id, ...rest } = made.value;
    begin(soupStore.add({ ...rest, origin: 'made' }));
  } finally {
    busy.value = false;
  }
}

// —— 你问（她出题 / 一起猜） ——
interface Judge {
  answer: Answer;
  hits: number[];
  close: boolean;
  line: string;
  expr?: string;
}
function parseJudge(v: unknown): Judge | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const answer = ANSWERS.find((a) => a === String(o.answer ?? '').trim());
  if (!answer) return null;
  const n = soup.value?.keys.length ?? 0;
  return {
    answer,
    hits: Array.isArray(o.hits) ? o.hits.map(Number).filter((i) => i >= 1 && i <= n) : [],
    close: o.close === true,
    line: typeof o.line === 'string' ? o.line.trim().slice(0, 60) : '',
    ...(typeof o.expr === 'string' && isExpression(o.expr) ? { expr: o.expr } : {}),
  };
}
async function ask(text?: string) {
  const q = (text ?? input.value).trim();
  if (!q || busy.value || !soup.value) return;
  input.value = '';
  herIdea.value = '';
  busy.value = true;
  try {
    say('user', q);
    const r = await chat.sceneJson(chatId.value, { name: mode.value === 'host' ? 'soup-judge' : 'soup-judge-coop', input: soupInput(true, [`这一问：${q}`]) }, parseJudge);
    if (!r.ok) return fail(r);
    const j = r.value;
    const fresh = j.hits.filter((i) => !hit.value.includes(i));
    hit.value = [...hit.value, ...fresh];
    close.value = j.close;
    if (mode.value === 'host') {
      const line = j.line && !leaks(j.line) ? j.line : '';
      herLine.value = line ? `${j.answer}。${line}` : `${j.answer}。`;
      say('assistant', herLine.value, { expression: j.expr ?? null, agent: true });
      if (j.expr) chars.setExpression(her.value.id, j.expr);
    } else {
      say('narrator', `主持人：${j.answer}`);
    }
    qa.value.push({ q, a: j.answer, by: 'you' });
    if (mode.value === 'coop' && (fresh.length || qa.value.length % 3 === 0)) void teammate();
    if (soup.value.keys.length && hit.value.length === soup.value.keys.length) showToast('关键点都问出来了，说出你的答案吧');
  } finally {
    busy.value = false;
  }
}

// —— 一起猜：她当队友（她那边没有汤底） ——
async function teammate() {
  const r = await chat.sceneReply(chatId.value, { task: 'soup-teammate', input: soupInput(false), cue: `第 ${qa.value.length} 问后` });
  if (!r.ok) return fail(r);
  herLine.value = r.message.text;
  herIdea.value = /我想问[:：]\s*(.+)/.exec(r.message.text)?.[1]?.trim() ?? '';
}

// —— 提示 ——
async function hint() {
  if (busy.value || !soup.value) return;
  busy.value = true;
  hints.value += 1;
  const level = `提示等级：${Math.min(3, hints.value)}`;
  try {
    if (mode.value === 'host') {
      const r = await chat.sceneReply(chatId.value, { task: 'soup-hint', input: soupInput(true, [level]), cue: `第 ${hints.value} 次提示` });
      if (!r.ok) return fail(r);
      herLine.value = r.message.text;
    } else {
      const r = await chat.sceneJson(chatId.value, { name: 'soup-hint-coop', input: soupInput(true, [level]) }, (v) =>
        v && typeof v === 'object' && typeof (v as { hint?: unknown }).hint === 'string' ? (v as { hint: string }).hint.trim() : null,
      );
      if (!r.ok) return fail(r);
      say('narrator', `主持人提示：${r.value}`);
      herLine.value = `主持人提示：${r.value}`;
    }
  } finally {
    busy.value = false;
  }
}

// —— 说出答案 ——
async function submitAnswer() {
  const a = answerText.value.trim();
  if (!a || !soup.value) return;
  answerOpen.value = false;
  answerText.value = '';
  busy.value = true;
  try {
    say('user', `我的答案：${a}`);
    const r = await chat.sceneJson(chatId.value, { name: 'soup-final', input: soupInput(true, [`${userName.value}的答案：${a}`]) }, (v) => {
      const o = v as { verdict?: unknown; line?: unknown } | null;
      const verdict = ['对', '半对', '不对'].find((x) => x === String(o?.verdict ?? '').trim());
      return verdict ? { verdict, line: typeof o?.line === 'string' ? o.line.trim() : '' } : null;
    });
    if (!r.ok) return fail(r);
    const { verdict, line } = r.value;
    say(mode.value === 'host' ? 'assistant' : 'narrator', `${mode.value === 'host' ? '' : '主持人：'}${verdict}${line && !leaks(line) ? `。${line}` : ''}`, { agent: mode.value === 'host' });
    if (verdict === '不对') return showToast('不对，再想想');
    result.value = verdict === '对' ? 'solved' : 'partial';
    await reveal();
  } finally {
    busy.value = false;
  }
}
async function giveUp() {
  result.value = 'gave-up';
  await reveal();
}

// —— 你出题，她猜 ——
async function herTurn() {
  herQuestion.value = '';
  herGuess.value = '';
  const r = await chat.sceneReply(chatId.value, { task: 'soup-guess', input: soupInput(false), cue: cue.value });
  if (!r.ok) return fail(r);
  herLine.value = r.message.text;
  const guess = /我猜[:：]\s*([\s\S]+)/.exec(r.message.text)?.[1]?.trim();
  const question = /我想问[:：]\s*(.+)/.exec(r.message.text)?.[1]?.trim();
  if (guess) herGuess.value = guess;
  else herQuestion.value = question ?? r.message.text.trim();
}
async function answerHer(a: Answer) {
  qa.value.push({ q: herQuestion.value, a, by: 'her' });
  say('user', a);
  await herTurn();
}
async function judgeHer(v: '对' | '半对' | '不对') {
  say('user', v === '对' ? '猜对了！' : v === '半对' ? '对了一半' : '不对');
  if (v === '对') {
    result.value = 'solved';
    await reveal();
  } else await herTurn();
}

// —— 揭晓：汤底这时才存进聊天 ——
async function reveal() {
  const s = soup.value;
  if (!s) return;
  phase.value = 'reveal';
  if (s.truth) chat.push(chatId.value, 'narrator', [{ type: 'text', text: `汤底：${s.truth}` }], { meta: { scene: 'game', cue: '揭晓' } });
  const r = await chat.sceneReply(chatId.value, { task: 'soup-reveal', input: soupInput(true, [`结果：${{ solved: '猜出来了', partial: '猜对了一半', 'gave-up': '认输了' }[result.value ?? 'gave-up']}`]), cue: '揭晓' });
  if (r.ok) herLine.value = r.message.text;
  else fail(r);
  const card: MessagePart = { type: 'game', logId: uid('game'), game: 'soup', title: s.title, mode: mode.value, result: result.value ?? 'gave-up', questions: qa.value.length, hints: hints.value, ...(s.truth ? { truth: s.truth } : {}) };
  chat.postCard(chatId.value, 'user', card);
  played.value.push(`海龟汤《${s.title}》`);
}
</script>

<template>
  <SceneShell scene-id="game" pose="sit" :line="herLine" :typing="replying && !herLine" :layout="{ left: 78, bottom: 56, height: 30 }">
    <div v-if="notConnected" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ notConnected }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>

    <!-- 开始前选游戏 -->
    <Segmented v-if="choosing" v-model="game" :options="GAMES" class="mb-3" />

    <!-- 真心话大冒险 -->
    <TruthDare v-if="game === 'truthdare'" v-model:line="herLine" v-model:phase="tdPhase" @fail="fail" @progress="(s) => (tdProgress = s)" @done="(s) => played.push(s)" />

    <!-- 海龟汤：选玩法、选题 -->
    <template v-else-if="phase === 'menu'">
      <div class="flex gap-2">
        <button v-for="m in MODES" :key="m.id" type="button" class="chip" :class="{ on: mode === m.id }" @click="mode = m.id">{{ m.label }}</button>
      </div>
      <div class="text-[12.5px] text-ink-3 mt-1.5">{{ MODES.find((m) => m.id === mode)?.desc }}</div>
      <template v-if="mode !== 'guest'">
        <label class="flex items-center gap-2 mt-3 text-[13px]"><van-switch v-model="allowRed" size="16px" />也出红汤（涉及死亡、恐怖，不写血腥细节）</label>
        <div class="label">题库</div>
        <button v-for="s in list" :key="s.id" type="button" class="soup press" @click="begin(s)">
          <span class="flex-1 min-w-0 text-left">
            <span class="block truncate text-[14.5px]">{{ s.title }}</span>
            <span class="block truncate text-[12px] text-ink-3">{{ s.kind }} · {{ '★'.repeat(s.difficulty) }}{{ s.origin === 'made' ? ' · 现编的' : '' }}</span>
          </span>
          <span class="i-lucide-chevron-right text-ink-3" />
        </button>
        <van-button round block class="!mt-2.5" :loading="busy" loading-text="正在编、正在自检…" @click="makeOne">让{{ her.pronoun }}现编一道</van-button>
      </template>
      <template v-else>
        <div class="label">汤面（{{ her.pronoun }}看得到）</div>
        <textarea v-model="mySurface" class="area" rows="3" placeholder="写下汤面" aria-label="汤面" />
        <div class="label">汤底（可以不写；写了用来判{{ her.pronoun }}最后的答案，揭晓前不会发给{{ her.pronoun }}）</div>
        <textarea v-model="myTruth" class="area" rows="3" placeholder="写下汤底" aria-label="汤底" />
        <van-button type="primary" round block class="!mt-3" @click="beginMine">开始，让{{ her.pronoun }}来猜</van-button>
      </template>
    </template>

    <!-- 玩的时候 -->
    <template v-else-if="phase === 'playing' && soup">
      <div class="surface"><span class="text-ink-3">《{{ soup.title }}》</span>{{ soup.surface }}</div>
      <div v-if="mode !== 'guest' && soup.keys.length" class="text-[12.5px] text-ink-3 mt-1.5">
        关键点 {{ hit.length }} / {{ soup.keys.length }}<template v-if="close"> · 很接近了</template><template v-if="hints"> · 提示 {{ hints }} 次</template>
      </div>
      <div class="qa">
        <div v-for="(x, i) in qa" :key="i" class="qa-row">
          <span class="text-ink-3 num">{{ i + 1 }}.</span><span class="flex-1">{{ x.by === 'her' ? `${her.pronoun}：` : '' }}{{ x.q }}</span><span class="ans">{{ x.a }}</span>
        </div>
      </div>

      <template v-if="mode !== 'guest'">
        <button v-if="herIdea" type="button" class="idea" @click="ask(herIdea)">用{{ her.pronoun }}的问题：{{ herIdea }}</button>
        <div class="flex gap-2 mt-2">
          <input v-model="input" class="field" placeholder="问一个是非题" aria-label="问题" @keydown.enter="ask()" />
          <van-button size="small" round :loading="busy" @click="ask()">问</van-button>
        </div>
        <div class="flex gap-2 mt-2 btns">
          <van-button size="small" round block :disabled="busy" @click="hint">要提示</van-button>
          <van-button size="small" round block :disabled="busy" @click="answerOpen = true">我知道了</van-button>
          <van-button size="small" round block :disabled="busy" @click="giveUp">认输</van-button>
          <van-button v-if="mode === 'coop'" size="small" round block :disabled="replying" @click="teammate">问问{{ her.pronoun }}</van-button>
        </div>
      </template>
      <template v-else>
        <template v-if="herQuestion">
          <div class="label">{{ her.pronoun }}问：{{ herQuestion }}</div>
          <div class="flex gap-2 btns">
            <van-button v-for="a in ANSWERS" :key="a" size="small" round block :disabled="replying" @click="answerHer(a)">{{ a }}</van-button>
          </div>
        </template>
        <template v-else-if="herGuess">
          <div class="label">{{ her.pronoun }}猜：{{ herGuess }}</div>
          <div class="flex gap-2 btns">
            <van-button size="small" round block type="primary" @click="judgeHer('对')">对</van-button>
            <van-button size="small" round block @click="judgeHer('半对')">半对</van-button>
            <van-button size="small" round block @click="judgeHer('不对')">不对</van-button>
          </div>
        </template>
        <van-button v-else size="small" round block class="!mt-2" :loading="replying" @click="herTurn">让{{ her.pronoun }}接着问</van-button>
        <van-button size="small" round block class="!mt-2" @click="giveUp">结束这局</van-button>
      </template>
    </template>

    <!-- 揭晓 -->
    <template v-else-if="soup">
      <div class="text-[15px] font-600">《{{ soup.title }}》{{ { solved: '猜出来了！', partial: '猜对了一半', 'gave-up': '揭晓' }[result ?? 'gave-up'] }}</div>
      <div v-if="soup.truth" class="surface mt-2"><span class="text-ink-3">汤底：</span>{{ soup.truth }}</div>
      <div class="text-[12.5px] text-ink-3 mt-1.5">问了 {{ qa.length }} 个问题<template v-if="hints"> · 提示 {{ hints }} 次</template> · 对局卡片已经发进聊天</div>
      <div class="flex gap-2.5 mt-3">
        <van-button round block @click="phase = 'menu'">再来一道</van-button>
        <van-button type="primary" round block @click="router.push(`/chat/${chatId}`)">回聊天</van-button>
      </div>
    </template>

    <!-- 放到 body 下：场景面板有 backdrop-filter，弹层留在里面会被关在面板里 -->
    <van-popup v-model:show="answerOpen" position="bottom" round teleport="body">
      <div class="p-4">
        <div class="text-[15px] font-600 mb-2">说出你的答案</div>
        <textarea v-model="answerText" class="area" rows="3" placeholder="把你推理出来的经过写下来" aria-label="答案" />
        <van-button type="primary" round block class="!mt-2" @click="submitAnswer">提交</van-button>
      </div>
    </van-popup>
  </SceneShell>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.label {
  margin: 12px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.chip {
  height: 30px;
  padding: 0 12px;
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
.soup {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 2px;
  border-bottom: 1px solid var(--border);
}
.surface {
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  font-size: 14px;
  line-height: 1.6;
}
.qa {
  max-height: 160px;
  overflow-y: auto;
  margin-top: 8px;
}
.qa-row {
  display: flex;
  gap: 6px;
  padding: 5px 0;
  font-size: 13.5px;
  border-bottom: 1px dashed var(--border);
}
.ans {
  flex-shrink: 0;
  color: var(--accent-ink);
  font-weight: 600;
}
.idea {
  width: 100%;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 13px;
  text-align: left;
  color: var(--accent-ink);
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
.btns :deep(.van-button) {
  padding: 0 6px;
  white-space: nowrap;
}
</style>
