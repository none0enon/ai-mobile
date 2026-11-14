<script setup lang="ts">
import { isPokePreset, pokeHow, pokeLine, POKE_HOWS, POKE_LEVEL, presetLevels, type PokeHotspot, type PokeHow, type PokePart, type PresetUseId } from '@app/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import SceneShell from '@/components/scene/SceneShell.vue';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import { services } from '@/services';
import { personaOf } from '@/services/prompt';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';

/**
 * 戳戳乐（设计文档 §9.7）：用手戳、用嘴亲、蹭一蹭；点一下是一下，长按是久一点（摸着 / 亲着 / 蹭着不放）。
 * - 碰到的那一下：立刻换表情、震动、冒个小图标，好感 +1（长按 +2）；
 * - 连着碰的几下合成一次（停手 0.8 秒，或者等她说完上一句）：先在聊天里记一条"你亲了亲她的脸，连着 3 下"，再让她回应。
 *   用"戳戳乐"这个用途的功能预设，三种碰法各是一个场景任务（poke-hand / poke-mouth / poke-rub），程序只填这一次碰了哪里、怎么碰、几下；
 *   「陪伴 · 快速」的模型，她写的 [expr:] / [pose:] 换成她自己的立绘；
 * - 尺度也在预设里：触发条件写了 poke-level:名字 的块（POKE_LEVEL），按块的顺序列出来，选了哪个就只发那一块；
 * - "身子"那块没有具体的部位，当作在她身上乱碰：有三成的可能碰到不该碰的地方（照 SleepTogether 的乱摸），怎么反应看尺度；
 * - 被碰多少下她都不会烦、不会生气。离开时那一段写"戳了 3 下、亲了 2 下"。
 */
const USE: PresetUseId = 'scene:poke';
/** 停手多久把攒着的这几下给她 */
const GATHER_MS = 800;
/** 在身上乱碰时碰到不该碰的地方的可能 */
const SENSITIVE_CHANCE = 0.3;
/** 没有具体部位、当作在身上乱碰的热区 */
const LOOSE_PARTS = new Set(['body']);
/** 上次选的碰法、尺度（只记在这台设备上，下次进来接着用） */
const HOW_KEY = 'ai-mobile:poke-how';
const LEVEL_KEY = 'ai-mobile:poke-level';
/** 长按时冒出来的图标（点一下用碰法自己的图标） */
const LONG_ICON: Record<PokeHow, string> = { hand: 'i-lucide-hand-heart', mouth: 'i-lucide-heart', rub: 'i-lucide-cat' };

interface Touch {
  label: string;
  part: string;
  how: PokeHow;
  hold: boolean;
  sensitive: boolean;
}

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const ai = useAiStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 浏览器不让存：这次照样用，下次回到默认的
  }
}

// —— 怎么碰 ——
const how = ref<PokeHow>(pokeHow(load(HOW_KEY))?.id ?? 'hand');
const howDef = computed(() => pokeHow(how.value) ?? POKE_HOWS[0]!);
const pokeAs = computed(() => ({ verb: howDef.value.verb, tap: howDef.value.icon, long: LONG_ICON[how.value] }));
function pickHow(id: PokeHow) {
  how.value = id;
  save(HOW_KEY, id);
}

// —— 预设和尺度 ——
const preset = computed(() => lib.presetForUse(USE, her.value));
/** 选的预设里有没有戳戳乐的块（跟随对话预设、换成别的功能预设时没有：她照样回应，只是不分怎么碰、没有尺度） */
const presetReady = computed(() => isPokePreset(preset.value));
const pokeFirst = (p: { name: string }) => p.name.includes('戳戳乐');
const presetOpen = ref(false);
/** 预设里的尺度，说明就是那一块的内容（开头的【…】标题不重复显示） */
const levels = computed(() =>
  presetLevels(preset.value, POKE_LEVEL).map(({ name, block }) => ({
    name,
    desc: block.content.replaceAll('{{user}}', userName.value).replaceAll('{{char}}', her.value.name).replace(/^【[^】]*】\s*/, '').trim(),
  })),
);
const picked = ref(load(LEVEL_KEY));
/** 选中的尺度：上次选的还在预设里就用它，不然用预设里的第一个；预设里没有尺度时为空。改了下一次回应就照新的 */
const level = computed(() => levels.value.find((l) => l.name === picked.value)?.name ?? levels.value[0]?.name ?? '');
const levelDesc = computed(() => levels.value.find((l) => l.name === level.value)?.desc ?? '');
function pickLevel(name: string) {
  picked.value = name;
  save(LEVEL_KEY, name);
}

// —— 碰她 ——
const showZones = ref(false);
const total = ref(0);
/** 这次碰了哪儿几下："亲脸 ×3" */
const counts = ref<Record<string, number>>({});
const byHow = ref<Partial<Record<PokeHow, number>>>({});
/** 攒着还没给她的几下 */
const pending: Touch[] = [];
const gathering = ref(0);
const busy = ref(false);
const line = ref('');
const notConnected = ref('');
const failed = ref('');
/** 上一次让她回应的请求（没回上来时重试用；碰的那几下已经记进聊天了） */
let lastAsk: { task: string; input: string; flags: string[] } | null = null;
let gatherTimer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

/** 碰到的那一下先换的表情（程序说的情绪，按名字对到她自己的表情上）；她开口以后按她写的 [expr:] 换 */
function firstLook(h: PokeHotspot, t: Touch): string {
  if (t.sensitive) return 'surprised';
  if (t.how === 'mouth') return t.hold ? 'blush' : 'shy';
  if (t.how === 'rub') return t.hold ? 'laugh' : 'smile';
  return (t.hold && h.longPress ? h.longPress : h.tap).expression;
}

function poke(h: PokeHotspot, kind: 'tap' | 'long') {
  const t: Touch = { label: h.label, part: h.part, how: how.value, hold: kind === 'long', sensitive: LOOSE_PARTS.has(h.part) && Math.random() < SENSITIVE_CHANCE };
  services.native.vibrate(t.hold ? [12, 40, 12] : 14);
  chars.setExpression(her.value.id, firstLook(h, t));
  chars.bumpAffection(her.value.id, t.hold ? 2 : 1);
  total.value += 1;
  const key = `${howDef.value.verb}${h.label}`;
  counts.value[key] = (counts.value[key] ?? 0) + 1;
  byHow.value[t.how] = (byHow.value[t.how] ?? 0) + 1;
  pending.push(t);
  gathering.value = pending.length;
  later();
}

function later() {
  clearTimeout(gatherTimer);
  gatherTimer = setTimeout(() => void send(), GATHER_MS);
}

/** 同样碰法、同一个地方的几下合成一条："你亲了亲她的脸，连着 3 下" */
function group(batch: Touch[]): PokePart[] {
  const out: PokePart[] = [];
  for (const t of batch) {
    const same = out.find((p) => p.target === t.label && p.how === t.how && !!p.hold === t.hold && !!p.sensitive === t.sensitive);
    if (same) same.times = (same.times ?? 1) + 1;
    else out.push({ type: 'poke', actor: 'user', target: t.label, how: t.how, ...(t.hold ? { hold: true } : {}), ...(t.sensitive ? { sensitive: true } : {}) });
  }
  return out;
}

const togetherLine = computed(() => {
  const mode = chat.chatById(chatId.value)?.togetherMode;
  if (mode === 'remote') return `连线（${userName.value}在自己那边，隔着屏幕逗你）`;
  if (mode === 'bring') return `你在${userName.value}那边，就在${userName.value}身边`;
  return `${userName.value}来你这边了，就在你身边`;
});

/** 这一次的输入，只放数据：怎么在一起、碰了哪里、怎么碰、几下。她怎么回应、尺度写在预设的块里 */
function pokeInput(batch: Touch[], parts: PokePart[]): string {
  const you = userName.value;
  const loose = [...new Set(batch.filter((t) => LOOSE_PARTS.has(t.part)).map((t) => t.label))];
  return [
    `你们怎么在一起：${togetherLine.value}`,
    `${you}这一次：\n${parts.map((p) => `- ${pokeLine(p, you, her.value.name)}`).join('\n')}`,
    loose.length ? `碰在"${loose.join('、')}"上的是没碰在具体的地方，在你身上乱碰` : '',
    `今天在戳戳乐里一共被碰了 ${total.value} 下`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 把攒着的这几下给她：先记进聊天，再让她回应；她还在说上一句时等她说完 */
async function send() {
  if (!alive || busy.value || !pending.length || !chatId.value) return;
  const status = ai.status('companion');
  if (!status.live) {
    pending.length = 0;
    gathering.value = 0;
    notConnected.value = `「陪伴 · 快速」还没接通：${status.reason}`;
    return;
  }
  // 聊天那边还在写别的回复：过一会儿再给她
  if (chat.streams[chatId.value]) return later();
  const batch = pending.splice(0);
  gathering.value = 0;
  const parts = group(batch);
  chat.push(chatId.value, 'user', parts, { meta: { scene: 'poke' } });
  // 这一次最后那下的碰法是场景任务；中途换过碰法的，前面那几种的块也一起打开
  const tasks = [...new Set(batch.map((t) => pokeHow(t.how)?.task).filter((x): x is string => !!x))];
  const task = tasks.at(-1) ?? howDef.value.task;
  await ask({ task, input: pokeInput(batch, parts), flags: tasks.filter((x) => x !== task) });
  // 她说话的时候你又碰了的：接着给她
  if (alive && pending.length) later();
}

async function ask(req: { task: string; input: string; flags: string[] }) {
  lastAsk = req;
  busy.value = true;
  failed.value = '';
  line.value = '';
  try {
    const r = await chat.sceneReply(chatId.value, {
      task: req.task,
      input: req.input,
      use: USE,
      // 尺度在回应时才定：改了尺度，下一次回应就照新的
      flags: [...req.flags, ...(level.value ? [`${POKE_LEVEL}${level.value}`] : [])],
      minTokens: 400,
      quick: true,
      onText: (t) => {
        if (alive) line.value = t;
      },
    });
    if (!alive) return;
    if (r.ok) {
      notConnected.value = '';
      lastAsk = null;
      line.value = r.message.text;
    } else if (r.notConnected) notConnected.value = r.reason;
    else failed.value = r.reason;
  } finally {
    busy.value = false;
  }
}

async function retry() {
  if (!lastAsk || busy.value) return;
  await ask(lastAsk);
  if (alive && pending.length) later();
}

const shown = computed(() => line.value || (busy.value ? '' : '戳戳看？……我才没有在期待。'));

/** 离开时那一段的总结："戳了 3 下、亲了 2 下" */
function leaveNote(): string | undefined {
  const bits = POKE_HOWS.filter((h) => byHow.value[h.id]).map((h) => `${h.verb}了 ${byHow.value[h.id]} 下`);
  return bits.length ? bits.join('、') : undefined;
}

onMounted(() => chat.setLeaveSummary(her.value.id, leaveNote));
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(gatherTimer);
  chat.setLeaveSummary(her.value.id, null);
});
</script>

<template>
  <SceneShell
    scene-id="poke"
    backdrop="room"
    :line="shown"
    :typing="busy && !line"
    pokeable
    :show-hotspots="showZones"
    :poke-as="pokeAs"
    :layout="{ left: 50, bottom: 30, height: 62 }"
    @poke="poke"
  >
    <template #actions>
      <button class="zones" :class="{ on: showZones }" @click="showZones = !showZones"><span class="i-lucide-scan" />热区</button>
    </template>
    <template #overlay>
      <div v-if="gathering > 1" class="combo num">{{ howDef.verb }} ×{{ gathering }}</div>
    </template>

    <!-- 怎么碰 -->
    <div class="hows" role="radiogroup" aria-label="怎么碰">
      <button
        v-for="h in POKE_HOWS"
        :key="h.id"
        type="button"
        role="radio"
        class="how press"
        :class="{ on: how === h.id }"
        :aria-checked="how === h.id"
        :data-how="h.id"
        @click="pickHow(h.id)"
      >
        <span :class="h.icon" class="text-[18px]" />{{ h.label }}
      </button>
    </div>

    <!-- 尺度：预设里的块 -->
    <template v-if="levels.length">
      <div class="label">尺度</div>
      <div class="flex flex-wrap gap-2">
        <button v-for="l in levels" :key="l.name" type="button" class="level" :class="{ on: level === l.name }" :aria-pressed="level === l.name" @click="pickLevel(l.name)">
          {{ l.name }}
        </button>
      </div>
      <div class="level-desc">{{ levelDesc }}</div>
    </template>
    <p v-else-if="presetReady" class="warn">这个预设里没有尺度：在预设里给一块填上"戳戳乐的尺度"，这里就能选。</p>

    <button type="button" class="preset-row press" @click="presetOpen = true">
      <span class="i-lucide-sliders-horizontal shrink-0 text-ink-3" />
      <span class="flex-1 min-w-0 text-left truncate">预设：{{ preset?.name ?? '没有功能预设' }}</span>
      <span class="text-accent-ink shrink-0">换</span>
    </button>
    <p v-if="!presetReady" class="warn">这个预设里没有戳戳乐的块：她照样会回应，但不分用手、用嘴、蹭蹭，也没有尺度；换成"戳戳乐"或者从它复制一份。</p>

    <div v-if="notConnected" class="mini-notice" data-testid="poke-not-connected">
      <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ notConnected }}</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>
    <div v-else-if="failed" class="mini-notice">
      <span class="i-lucide-circle-alert shrink-0" /><span class="flex-1 min-w-0">{{ her.pronoun }}没回上来：{{ failed }}</span>
      <button type="button" class="text-accent-ink shrink-0" :disabled="busy" @click="retry">重试</button>
    </div>

    <div class="flex items-center gap-3 mt-3">
      <span class="i-lucide-heart text-accent text-[20px]" />
      <div class="flex-1">
        <div class="flex justify-between text-[12.5px] text-ink-3"><span>好感</span><span class="num">{{ her.relationship.affection }} / 100</span></div>
        <van-progress :percentage="her.relationship.affection" :show-pivot="false" stroke-width="6" />
      </div>
    </div>
    <div v-if="total" class="flex flex-wrap gap-2 mt-3">
      <span class="chip num">这次碰了 {{ total }} 下</span>
      <span v-for="(n, k) in counts" :key="k" class="chip num">{{ k }} ×{{ n }}</span>
    </div>
    <p class="text-[12.5px] text-ink-3 mt-3 leading-relaxed">
      选好怎么碰，点一下是一下，长按是久一点（摸着、亲着、蹭着不放）；连着碰的几下合成一次，{{ her.pronoun }}每次都会回应，碰多少下都不会烦。
      {{ her.pronoun }}怎么回应、尺度到哪一步都写在预设里；热区在
      <RouterLink :to="`/me/characters/${her.id}?tab=sprite`" class="text-accent-ink">角色 → 立绘</RouterLink> 里调。
    </p>

    <!-- 放到 body 下：场景面板有 backdrop-filter，弹层留在里面会被关在面板里 -->
    <van-popup v-model:show="presetOpen" position="bottom" round teleport="body" :style="{ maxHeight: '80%' }">
      <div class="p-4">
        <div class="text-[15px] font-600">戳戳乐用哪个预设</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-3 leading-relaxed">
          用手、用嘴、蹭蹭各是一块，{{ her.pronoun }}每次怎么回应照那一块（「陪伴 · 快速」的模型）。尺度也是预设里的块：填了"戳戳乐的尺度"的那几块按顺序列在这里，改内容就改了这个尺度能到哪一步，加一块就多一个尺度。自带"戳戳乐"，可以复制一份改。
        </p>
        <PresetPicker :model-value="lib.useChoice(USE)" category="feature" follow :first="pokeFirst" @update:model-value="(id) => lib.setUse(USE, id)" />
      </div>
    </van-popup>
  </SceneShell>
</template>

<style scoped>
.zones {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 13px;
}
.zones.on {
  color: var(--accent-ink);
  border-color: var(--accent-line);
}
.combo {
  position: absolute;
  z-index: 9;
  top: 30%;
  right: 10%;
  font-size: 20px;
  font-weight: 800;
  color: var(--accent-ink);
  transform: rotate(-10deg);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}
.hows {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.how {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 42px;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 14px;
}
.how.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
  font-weight: 600;
}
.label {
  margin: 12px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.level {
  height: 30px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.level.on {
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
.mini-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 10px;
  padding: 6px 10px;
  border-radius: 12px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.4;
}
</style>
