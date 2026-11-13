<script setup lang="ts">
import { isDecorPreset, isExpression, parseControlTags, type MessagePart, type PresetUseId } from '@app/shared';
import { showConfirmDialog, showImagePreview, showToast } from 'vant';
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { putAsset } from '@/services/assets';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useDecorStore } from '@/stores/decor';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';
import AvatarEditor from './AvatarEditor.vue';
import { describeAvatar, describeAvatarOptions, parseAvatar, type Avatar } from './avatar';
import { DecorEngine } from './engine';
import {
  addItem,
  applyPlan,
  CATALOG,
  catalogItem,
  CATEGORIES,
  colorName,
  describeCatalog,
  describeRoom,
  duplicateItem,
  FLOOR_FINISHES,
  itemColor,
  MAX_ROOMS,
  moveItem,
  PALETTE,
  parsePlanActions,
  removeItem,
  resizeRoom,
  ROOM_SIZES,
  ROOM_TYPES,
  roomType,
  turnItem,
  WALL_FINISHES,
  type DecorCategory,
  type DecorRoom,
  type PlanAction,
} from './model';

/**
 * 一起游戏 · 装修小屋（设计文档 §9.11）：
 * - 一套小屋好几个房间（一开始主卧、次卧、客厅、厨房、洗手间、书房，能自己再添，最多 10 个），上面一排标签换房间，一次看一间。
 * - 3D 小屋（engine.ts）：布置时点家具选中、拖着挪、转向、换色、复制、收起；每间的墙纸地面、大小、名字；撤销重做。逛逛时你的小人走动、坐下、躺下。
 *   转视角用两根手指（一起拖或者拧着转），捏合缩放。
 * - 捏人（AvatarEditor.vue）：你和她的 Q 版小人（发型、发顶、刘海、渐变、套装、花纹、能多选的配饰）；她能给自己捏、帮你捏。
 * - 她：看看屋子说想法（decor-look）、动手布置（decor-plan，按格式写要添要挪的，程序照着摆、放不下的找附近空地）、
 *   捏小人（decor-avatar）、边装边聊（decor-chat）、收工时的话（decor-end）。每一步的规则都在"一起游戏 · 装修小屋"预设里。
 * 屋子和小人存在本机（stores/decor.ts），下次来还在。收工时拍一张照片，和对局卡片一起发进聊天。
 */
export type DecorPhase = 'menu' | 'playing' | 'end';

const USE: PresetUseId = 'game-decor';
const NIGHT_KEY = 'ai-mobile:decor-night';
const WISHES = ['温馨一点', '多放点绿植', '弄个看电影的角落', '换个颜色', '给我们添张床'];

const line = defineModel<string>('line', { required: true });
const phase = defineModel<DecorPhase>('phase', { required: true });
const emit = defineEmits<{
  fail: [r: { reason: string; notConnected?: boolean }];
  progress: [summary: string | null];
  done: [summary: string];
}>();

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const decor = useDecorStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

decor.homeOf(her.value.id);
const home = computed(() => decor.homes[her.value.id] ?? decor.homeOf(her.value.id));
const rooms = computed(() => home.value.rooms);
const room = computed(() => rooms.value[home.value.current] ?? rooms.value[0]!);
const presetReady = computed(() => isDecorPreset(lib.presetForUse(USE, her.value)));

// —— 3D ——
const canvas = ref<HTMLCanvasElement | null>(null);
const engine = shallowRef<DecorEngine | null>(null);
const mode = ref<'edit' | 'live'>('edit');
const selectedId = ref<string | null>(null);
const selected = computed(() => room.value.items.find((i) => i.id === selectedId.value) ?? null);
const selectedCat = computed(() => (selected.value ? catalogItem(selected.value.kind) : undefined));
function readNight(): boolean {
  try {
    return localStorage.getItem(NIGHT_KEY) === '1';
  } catch {
    return false;
  }
}
const night = ref(readNight());
const webglFailed = ref(false);

onMounted(() => {
  if (!canvas.value) return;
  try {
    const e = new DecorEngine(canvas.value, {
      select: (id) => select(id),
      move: (id, to) => {
        const res = moveItem(room.value, id, to);
        if (!res.ok) return showToast(res.reason);
        const name = catalogItem(room.value.items.find((i) => i.id === id)?.kind ?? '')?.name ?? '';
        commit(res.room, `挪了${name}`);
      },
      invalid: (reason) => showToast(reason),
      tapChibi: () => undefined,
      act: (text) => log.value.push(`${userName.value}${text}`),
    });
    e.setRoom(room.value);
    e.setAvatars(home.value.you, home.value.her);
    e.setNight(night.value);
    e.start();
    engine.value = e;
  } catch (err) {
    console.error('装修小屋的 3D 画面打不开：', err);
    webglFailed.value = true;
  }
});
onActivated(() => engine.value?.start());
onDeactivated(() => engine.value?.stop());
onBeforeUnmount(() => {
  alive = false;
  abort.abort();
  engine.value?.dispose();
  engine.value = null;
});
watch(room, (r) => engine.value?.setRoom(r));
watch(
  () => [home.value.you, home.value.her] as const,
  ([y, h]) => engine.value?.setAvatars(y, h),
);
watch(mode, (m) => {
  engine.value?.setMode(m);
  if (m === 'live') selectedId.value = null;
});
function toggleNight() {
  night.value = !night.value;
  engine.value?.setNight(night.value);
  try {
    localStorage.setItem(NIGHT_KEY, night.value ? '1' : '0');
  } catch {
    // 存不了就只管这一次
  }
}
function select(id: string | null) {
  selectedId.value = id;
  engine.value?.select(id);
}

// —— 改屋子：撤销、重做、这一次改了什么 ——
const undoStack = ref<DecorRoom[]>([]);
const redoStack = ref<DecorRoom[]>([]);
/** 这一次的改动（给她看） */
const log = ref<string[]>([]);
/** 这一次新放的（收工时还在的算"添了几件"）、其中她放的 */
const addedIds = ref<Set<string>>(new Set());
const herIds = ref<Set<string>>(new Set());

function clone(r: DecorRoom): DecorRoom {
  return JSON.parse(JSON.stringify(r)) as DecorRoom;
}
function commit(next: DecorRoom, what?: string) {
  undoStack.value = [...undoStack.value.slice(-49), clone(room.value)];
  redoStack.value = [];
  decor.setRoom(her.value.id, next);
  if (what) log.value.push(what);
  if (phase.value !== 'playing') phase.value = 'playing';
  emit('progress', `装修小屋「${next.name}」`);
}
function undo() {
  const prev = undoStack.value.at(-1);
  if (!prev || prev.id !== room.value.id) return;
  undoStack.value = undoStack.value.slice(0, -1);
  redoStack.value = [...redoStack.value, clone(room.value)];
  decor.setRoom(her.value.id, prev);
}
function redo() {
  const next = redoStack.value.at(-1);
  if (!next || next.id !== room.value.id) return;
  redoStack.value = redoStack.value.slice(0, -1);
  undoStack.value = [...undoStack.value, clone(room.value)];
  decor.setRoom(her.value.id, next);
}

// —— 房间：换一间、添一间、拆掉一间 ——
const addRoomOpen = ref(false);
function goRoom(index: number) {
  if (index === home.value.current || busy.value) return;
  select(null);
  // 撤销只管一间屋子里的事
  undoStack.value = [];
  redoStack.value = [];
  decor.setCurrent(her.value.id, index);
  log.value.push(`${userName.value}去了${room.value.name}`);
}
function addRoom(type: string) {
  if (busy.value) return;
  select(null);
  const made = decor.addRoom(her.value.id, type);
  addRoomOpen.value = false;
  if (!made) return showToast(`最多 ${MAX_ROOMS} 个房间`);
  undoStack.value = [];
  redoStack.value = [];
  log.value.push(`${userName.value}添了一间新房间「${made.name}」`);
  if (phase.value !== 'playing') phase.value = 'playing';
  emit('progress', `装修小屋「${made.name}」`);
}
async function removeRoom() {
  if (busy.value || rooms.value.length <= 1) return;
  const target = room.value;
  try {
    await showConfirmDialog({ title: `拆掉「${target.name}」？`, message: `里面的 ${target.items.length} 件家具会一起收走，拆了就找不回来了。` });
  } catch {
    return;
  }
  // 名字的草稿清掉：关面板时别把这个名字安到下一间头上
  nameDraft.value = '';
  finishOpen.value = false;
  select(null);
  undoStack.value = [];
  redoStack.value = [];
  if (decor.removeRoom(her.value.id, target.id)) log.value.push(`${userName.value}把「${target.name}」拆掉了`);
}

// —— 选中的那件 ——
function turnSelected() {
  if (!selected.value) return;
  const res = turnItem(room.value, selected.value.id);
  if (!res.ok) return showToast(res.reason);
  commit(res.room, `把${selectedCat.value?.name}转了个方向`);
}
function recolor(hex: string) {
  const it = selected.value;
  if (!it || itemColor(it) === hex) return;
  commit({ ...room.value, items: room.value.items.map((i) => (i.id === it.id ? { ...i, color: hex } : i)) }, `把${selectedCat.value?.name}换成了${colorName(hex)}`);
}
function duplicate() {
  if (!selected.value) return;
  const res = duplicateItem(room.value, selected.value.id);
  if (!res) return showToast('旁边放不下了');
  commit(res.room, `又放了一个${selectedCat.value?.name}`);
  addedIds.value.add(res.item.id);
  select(res.item.id);
  engine.value?.pop([res.item.id]);
}
function stash() {
  const it = selected.value;
  if (!it) return;
  const name = selectedCat.value?.name ?? '';
  select(null);
  commit(removeItem(room.value, it.id), `收起了${name}`);
}

// —— 家具目录 ——
const catalogOpen = ref(false);
const cat = ref<DecorCategory>('seat');
const thumbs = ref<Record<string, string>>({});
const catItems = computed(() => CATALOG.filter((c) => c.cat === cat.value));
function loadThumbs() {
  const e = engine.value;
  if (!e) return;
  // 一帧画几张，免得卡一下
  const todo = catItems.value.filter((c) => !thumbs.value[c.id]);
  const step = () => {
    const next = todo.splice(0, 3);
    if (!next.length || !catalogOpen.value) return;
    const add: Record<string, string> = {};
    for (const c of next) add[c.id] = e.thumbnail(c.id, c.colors[0]!);
    thumbs.value = { ...thumbs.value, ...add };
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
watch([catalogOpen, cat], ([open]) => {
  if (open) loadThumbs();
});
function addFromCatalog(kind: string) {
  const res = addItem(room.value, kind, { by: 'you' });
  const c = catalogItem(kind);
  if (!res) return showToast(`没地方放${c?.name ?? ''}了，先收起点东西`);
  catalogOpen.value = false;
  if (mode.value !== 'edit') mode.value = 'edit';
  commit(res.room, `添了${c?.name}`);
  addedIds.value.add(res.item.id);
  select(res.item.id);
  engine.value?.pop([res.item.id]);
}

// —— 墙和地面、屋子 ——
const finishOpen = ref(false);
function setFinish(key: 'wall' | 'floor', patch: { finish?: string; color?: string }) {
  const next = { ...room.value[key], ...patch };
  if (next.finish === room.value[key].finish && next.color === room.value[key].color) return;
  const list = key === 'wall' ? WALL_FINISHES : FLOOR_FINISHES;
  commit({ ...room.value, [key]: next }, `把${key === 'wall' ? '墙' : '地面'}换成了${colorName(next.color)}${list.find((f) => f.id === next.finish)?.name ?? ''}`);
}
function setSize(w: number, d: number) {
  if (w === room.value.w && d === room.value.d) return;
  const res = resizeRoom(room.value, w, d);
  commit(res.room, `把房间改成了 ${w} × ${d} 格`);
  if (res.dropped) showToast(`放不下的 ${res.dropped} 件先收起来了，可以撤销`);
}
const nameDraft = ref('');
watch(finishOpen, (open) => {
  if (open) nameDraft.value = room.value.name;
  else {
    const n = nameDraft.value.trim().slice(0, 16);
    if (n && n !== room.value.name) commit({ ...room.value, name: n }, `把房间的名字改成了「${n}」`);
  }
});

// —— 捏人 ——
const avatarOpen = ref(false);
const avatarWho = ref<'you' | 'her'>('you');
function openAvatar(who: 'you' | 'her') {
  avatarWho.value = who;
  avatarOpen.value = true;
}
function saveAvatar(who: 'you' | 'her', a: Avatar) {
  decor.setAvatar(her.value.id, who, a);
  log.value.push(`${who === 'you' ? `${userName.value}换了自己的样子` : `${userName.value}给${her.value.name}换了个样子`}：${describeAvatar(a)}`);
  if (who === 'her') engine.value?.herReact('blush');
}

// —— 她 ——
type Busy = '' | 'look' | 'plan' | 'avatar' | 'chat' | 'end';
const busy = ref<Busy>('');
const talkText = ref('');
const planOpen = ref(false);
const wish = ref('');
let alive = true;
const abort = new AbortController();

function fail(r: { reason: string; notConnected?: boolean }) {
  if (alive) emit('fail', r);
}

const togetherLine = computed(() => {
  const m = chat.chatById(chatId.value)?.togetherMode;
  if (m === 'visit') return `${userName.value}来你这边了，坐在你旁边，一起在平板上装修`;
  if (m === 'bring') return `你在${userName.value}这边，一起在平板上装修`;
  return `连线（${userName.value}在自己那边，你在你那边，一起装修同一间小屋）`;
});

/** 这一次的输入，只放数据：怎么在一起、屋子现在的样子、你们俩的小人、这一次改了什么，加上这一步的情况 */
function decorInput(extra: (string | false)[]): string {
  return [
    `你们怎么在一起：${togetherLine.value}`,
    describeRoom(room.value, { you: userName.value, her: her.value.name }, rooms.value),
    `小人：${userName.value}是${describeAvatar(home.value.you)}；你是${describeAvatar(home.value.her)}`,
    log.value.length ? `这一次改了什么（按先后）：\n${log.value.slice(-14).join('\n')}` : '这一次还没动过',
    ...extra,
  ]
    .filter(Boolean)
    .join('\n');
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? parseControlTags(v, []).visible.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function say(role: 'user' | 'assistant' | 'narrator', text: string, extra: { expression?: string; agent?: boolean; cue?: string } = {}) {
  chat.push(chatId.value, role, [{ type: 'text', text }], {
    meta: { scene: 'game', cue: extra.cue ?? '装修小屋', ...(extra.agent ? { agent: 'companion' as const } : {}) },
    expression: extra.expression ?? null,
  });
  if (extra.expression) chars.setExpression(her.value.id, extra.expression);
}

/** 她说一段（看看屋子、聊天、收工）：流式显示，存进聊天 */
async function herReply(task: string, userText: string | undefined, extra: (string | false)[], cue = '装修小屋'): Promise<boolean> {
  busy.value = task === 'decor-end' ? 'end' : userText ? 'chat' : 'look';
  line.value = '';
  try {
    const r = await chat.sceneReply(chatId.value, {
      task,
      input: decorInput(extra),
      userText,
      cue,
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
    if (alive) {
      line.value = r.message.text;
      engine.value?.herReact(r.message.expression ?? chars.expression[her.value.id]);
    }
    return true;
  } finally {
    busy.value = '';
  }
}

async function look() {
  if (busy.value || !chatId.value) return;
  await herReply('decor-look', undefined, []);
}

async function talk() {
  const t = talkText.value.trim();
  if (!t || busy.value || !chatId.value) return;
  talkText.value = '';
  await herReply('decor-chat', t, []);
}

function parsePlan(v: unknown): { line: string; expr?: string; actions: PlanAction[] } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const actions = parsePlanActions(o.actions);
  const l = clean(o.line, 60);
  if (!actions.length && !l) return null;
  return { line: l, actions, ...(isExpression(o.expr) ? { expr: o.expr } : {}) };
}

async function herPlan() {
  if (busy.value || !chatId.value) return;
  const w = wish.value.trim();
  planOpen.value = false;
  wish.value = '';
  busy.value = 'plan';
  line.value = '';
  try {
    if (w) say('user', `帮我布置一下：${w}`);
    const res = await chat.sceneJson(
      chatId.value,
      {
        name: 'decor-plan',
        input: decorInput([
          w ? `${userName.value}想要：${w}` : `${userName.value}说：你来布置一下吧`,
          `能摆的家具（id（名字，占地））：\n${describeCatalog()}`,
          `墙纸：${WALL_FINISHES.map((f) => `${f.id}=${f.name}`).join('、')}；地面：${FLOOR_FINISHES.map((f) => `${f.id}=${f.name}`).join('、')}`,
          `调色盘：${PALETTE.map((p) => p.name).join('、')}`,
        ]),
      },
      parsePlan,
      abort.signal,
      { use: USE, minTokens: 900 },
    );
    if (!alive) return;
    if (!res.ok) return fail(res);
    const plan = res.value;
    const out = applyPlan(room.value, plan.actions);
    const said = plan.line || (out.done.length ? '弄好啦，你看看～' : '');
    if (said) {
      line.value = said;
      say('assistant', said, { expression: plan.expr, agent: true });
    }
    engine.value?.herReact(plan.expr ?? 'smile');
    if (!out.done.length) {
      showToast(out.skipped.length ? `${her.value.pronoun}想放的${out.skipped.join('、')}` : `${her.value.pronoun}这次没动`);
      return;
    }
    commit(out.room);
    log.value.push(`${her.value.name}${out.done.join('、')}`);
    say('narrator', `${her.value.name}${out.done.join('、')}${out.skipped.length ? `（${out.skipped.join('、')}）` : ''}`);
    for (const id of out.added) {
      addedIds.value.add(id);
      herIds.value.add(id);
    }
    engine.value?.pop(out.added);
    const first = out.added[0] ?? out.touched[0];
    if (first) engine.value?.herVisit(first);
    if (out.added.length === 1) select(out.added[0]!);
  } finally {
    busy.value = '';
  }
}

async function design(who: 'you' | 'her'): Promise<Avatar | null> {
  if (!chatId.value) return null;
  if (busy.value) {
    showToast(`${her.value.pronoun}还在忙上一件事`);
    return null;
  }
  busy.value = 'avatar';
  try {
    const base = who === 'you' ? home.value.you : home.value.her;
    const res = await chat.sceneJson(
      chatId.value,
      {
        name: 'decor-avatar',
        input: decorInput([
          who === 'her' ? `给谁捏：你自己（现在是${describeAvatar(base)}）` : `给谁捏：${userName.value}（现在是${describeAvatar(base)}）`,
          `能挑的选项：\n${describeAvatarOptions()}`,
        ]),
      },
      (v) => {
        const o = v as { avatar?: unknown; line?: unknown; expr?: unknown } | null;
        if (!o || typeof o.avatar !== 'object' || !o.avatar) return null;
        return { avatar: parseAvatar(o.avatar, base), line: clean(o.line, 50), ...(isExpression(o.expr) ? { expr: o.expr } : {}) };
      },
      abort.signal,
      { use: USE },
    );
    if (!alive) return null;
    if (!res.ok) {
      fail(res);
      if (res.notConnected) showToast(res.reason);
      return null;
    }
    const { avatar, line: l, expr } = res.value;
    if (l) {
      line.value = l;
      say('assistant', l, { expression: expr, agent: true });
    }
    say('narrator', `${her.value.name}${who === 'her' ? '给自己' : `给${userName.value}`}捏了个小人：${describeAvatar(avatar)}`);
    engine.value?.herReact(expr ?? 'smile');
    return avatar;
  } finally {
    busy.value = '';
  }
}

// —— 拍照、收工 ——
function photo() {
  const url = engine.value?.snapshot();
  if (url) showImagePreview({ images: [url], closeable: true, showIndex: false });
}

async function finish() {
  if (busy.value || !chatId.value) return;
  select(null);
  let key: string | undefined;
  try {
    const url = engine.value?.snapshot('card');
    if (url) {
      const bin = atob(url.split(',')[1] ?? '');
      const bytes = new Uint8Array(new ArrayBuffer(bin.length));
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      key = await putAsset(bytes, 'image/jpeg');
    }
  } catch {
    // 拍不了照也照样收工
  }
  const ids = new Set(room.value.items.map((i) => i.id));
  const added = [...addedIds.value].filter((id) => ids.has(id)).length;
  const herAdded = [...herIds.value].filter((id) => ids.has(id)).length;
  const card: MessagePart = { type: 'game', logId: uid('game'), game: 'decor', room: room.value.name, items: room.value.items.length, added, herAdded, ...(key ? { photo: key } : {}) };
  chat.postCard(chatId.value, 'user', card);
  emit('done', `装修小屋「${room.value.name}」`);
  emit('progress', null);
  phase.value = 'end';
  const changes = [...log.value];
  await herReply('decor-end', undefined, [changes.length ? '' : '（这一次没怎么改，就是来看看）'], '收工');
  // 接着装就是新的一次
  log.value = [];
  addedIds.value = new Set();
  herIds.value = new Set();
  phase.value = 'menu';
}

const hint = computed(() =>
  mode.value === 'edit'
    ? '点家具选中；双指拖动或拧转换视角，捏合缩放'
    : '点地面走过去，点沙发、椅子坐下，点床躺下',
);
</script>

<template>
  <div class="decor" data-game="decor">
    <div v-if="!presetReady" class="warn">
      <span class="i-lucide-triangle-alert shrink-0" />
      <span class="flex-1 min-w-0">"一起游戏 · 装修小屋"选的预设里没有装修的几步，{{ her.pronoun }}的布置方案会读不出来</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/presets')">去看看</button>
    </div>

    <div class="rooms" role="tablist" aria-label="房间">
      <button v-for="(r, i) in rooms" :key="r.id" type="button" role="tab" class="room-tab" :class="{ on: i === home.current }" :aria-selected="i === home.current" :data-room="r.type" @click="goRoom(i)">
        <span :class="roomType(r.type).icon" />{{ r.name }}
      </button>
      <button v-if="rooms.length < MAX_ROOMS" type="button" class="room-tab add" aria-label="添一个房间" @click="addRoomOpen = true"><span class="i-lucide-plus" />添房间</button>
    </div>

    <div class="view">
      <canvas ref="canvas" class="block w-full h-full" aria-label="3D 小屋：点家具选中，拖着挪；两根手指拖动或拧转换视角" />
      <div v-if="webglFailed" class="fallback">这台设备打不开 3D 画面（WebGL），装修小屋玩不了</div>
      <div class="view-top">
        <div class="modes" role="tablist">
          <button type="button" role="tab" :aria-selected="mode === 'edit'" :class="{ on: mode === 'edit' }" @click="mode = 'edit'"><span class="i-lucide-hammer" />布置</button>
          <button type="button" role="tab" :aria-selected="mode === 'live'" :class="{ on: mode === 'live' }" @click="mode = 'live'"><span class="i-lucide-footprints" />逛逛</button>
        </div>
        <span class="flex-1" />
        <button type="button" class="round" :aria-label="night ? '换成白天' : '换成晚上'" @click="toggleNight"><span :class="night ? 'i-lucide-moon' : 'i-lucide-sun'" /></button>
        <button type="button" class="round" aria-label="视角回到正面" @click="engine?.resetView()"><span class="i-lucide-locate-fixed" /></button>
        <button type="button" class="round" aria-label="拍一张" @click="photo"><span class="i-lucide-camera" /></button>
      </div>
      <div v-if="!(selected && mode === 'edit')" class="hint">{{ hint }}</div>
      <!-- 选中的家具 -->
      <div v-if="selected && selectedCat && mode === 'edit'" class="sel" data-panel="selected">
        <div class="flex items-center gap-2">
          <span class="min-w-0">
            <span class="block font-600 text-[14px] truncate">{{ selectedCat.name }}<span v-if="selected.by" class="text-[11.5px] text-ink-3 font-400"> · {{ selected.by === 'her' ? `${her.pronoun}放的` : '你放的' }}</span></span>
            <span class="block text-[11px] text-ink-3 truncate">按住它拖着挪</span>
          </span>
          <span class="flex-1" />
          <button v-if="selectedCat.place !== 'wall'" type="button" class="tool-sm" aria-label="转个方向" @click="turnSelected"><span class="i-lucide-rotate-cw" /></button>
          <button type="button" class="tool-sm" aria-label="再放一个" @click="duplicate"><span class="i-lucide-copy" /></button>
          <button type="button" class="tool-sm" aria-label="收起来" @click="stash"><span class="i-lucide-trash-2" /></button>
          <button type="button" class="tool-sm on" aria-label="好了" @click="select(null)"><span class="i-lucide-check" /></button>
        </div>
        <div class="swatches">
          <button
            v-for="c in selectedCat.colors"
            :key="c"
            type="button"
            class="swatch"
            :class="{ on: itemColor(selected) === c }"
            :style="{ background: c }"
            :aria-label="colorName(c)"
            :title="colorName(c)"
            @click="recolor(c)"
          />
          <label class="swatch custom" aria-label="自己调颜色"><input type="color" :value="itemColor(selected)" @change="recolor(($event.target as HTMLInputElement).value)" /><span class="i-lucide-plus" /></label>
        </div>
      </div>
    </div>

    <div class="tools">
      <button type="button" class="tool" @click="catalogOpen = true"><span class="i-lucide-armchair" />家具</button>
      <button type="button" class="tool" @click="finishOpen = true"><span class="i-lucide-paint-roller" />房间</button>
      <button type="button" class="tool" @click="openAvatar('you')"><span class="i-lucide-user-round-pen" />捏人</button>
      <button type="button" class="tool icon" :disabled="!undoStack.length" aria-label="撤销" @click="undo"><span class="i-lucide-undo-2" /></button>
      <button type="button" class="tool icon" :disabled="!redoStack.length" aria-label="重做" @click="redo"><span class="i-lucide-redo-2" /></button>
    </div>

    <!-- 她 -->
    <div class="her-row">
      <van-button size="small" round :loading="busy === 'look'" :disabled="!!busy && busy !== 'look'" @click="look">问问{{ her.pronoun }}</van-button>
      <van-button size="small" round :loading="busy === 'plan'" loading-text="在摆…" :disabled="!!busy && busy !== 'plan'" @click="planOpen = true">让{{ her.pronoun }}布置</van-button>
      <van-button size="small" round type="primary" :loading="busy === 'end'" :disabled="!!busy && busy !== 'end'" @click="finish">收工</van-button>
    </div>
    <div class="flex gap-2 mt-2">
      <input v-model="talkText" class="field" :placeholder="`边装边和${her.pronoun}说…`" aria-label="说的话" @keydown.enter="talk" />
      <van-button size="small" round :loading="busy === 'chat'" :disabled="!talkText.trim() || (!!busy && busy !== 'chat')" @click="talk">说</van-button>
    </div>

    <!-- 家具目录 -->
    <van-popup v-model:show="catalogOpen" position="bottom" round teleport="body" :style="{ height: '62%' }">
      <div class="sheet" data-sheet="catalog">
        <div class="sheet-title">摆点什么</div>
        <div class="cats">
          <button v-for="c in CATEGORIES" :key="c.id" type="button" class="cat" :class="{ on: cat === c.id }" @click="cat = c.id"><span :class="c.icon" />{{ c.label }}</button>
        </div>
        <div class="grid">
          <button v-for="c in catItems" :key="c.id" type="button" class="cell press" :data-kind="c.id" @click="addFromCatalog(c.id)">
            <img v-if="thumbs[c.id]" :src="thumbs[c.id]" :alt="c.name" class="thumb" />
            <span v-else class="thumb ph" :style="{ background: c.colors[0] }" />
            <span class="cell-name">{{ c.name }}</span>
          </button>
        </div>
      </div>
    </van-popup>

    <!-- 墙和地面 -->
    <van-popup v-model:show="finishOpen" position="bottom" round teleport="body" :style="{ maxHeight: '78%' }">
      <div class="sheet" data-sheet="finishes">
        <div class="sheet-title">这个房间</div>
        <div class="label">房间的名字</div>
        <input v-model="nameDraft" class="field w-full" maxlength="16" :placeholder="roomType(room.type).name" aria-label="房间的名字" />
        <div class="label">房间大小</div>
        <div class="chips">
          <button v-for="s in ROOM_SIZES" :key="s.label" type="button" class="chip-btn" :class="{ on: room.w === s.w && room.d === s.d }" @click="setSize(s.w, s.d)">{{ s.label }}（{{ s.w }} × {{ s.d }}）</button>
        </div>
        <template v-for="key in ['wall', 'floor'] as const" :key="key">
          <div class="label">{{ key === 'wall' ? '墙纸' : '地面' }}</div>
          <div class="chips">
            <button v-for="f in key === 'wall' ? WALL_FINISHES : FLOOR_FINISHES" :key="f.id" type="button" class="chip-btn" :class="{ on: room[key].finish === f.id }" @click="setFinish(key, { finish: f.id })">{{ f.name }}</button>
          </div>
          <div class="swatches mt-2">
            <button
              v-for="p in PALETTE"
              :key="p.hex"
              type="button"
              class="swatch"
              :class="{ on: room[key].color === p.hex }"
              :style="{ background: p.hex }"
              :aria-label="p.name"
              :title="p.name"
              @click="setFinish(key, { color: p.hex })"
            />
          </div>
        </template>
        <button v-if="rooms.length > 1" type="button" class="danger" @click="removeRoom"><span class="i-lucide-trash-2" />拆掉这个房间</button>
      </div>
    </van-popup>

    <!-- 添一个房间 -->
    <van-popup v-model:show="addRoomOpen" position="bottom" round teleport="body">
      <div class="sheet" data-sheet="add-room">
        <div class="sheet-title">添一个什么房间？</div>
        <div class="text-[12.5px] text-ink-3">现在 {{ rooms.length }} 间，最多 {{ MAX_ROOMS }} 间；添好会先摆上几件家具，名字、大小、墙纸之后都能改</div>
        <div class="grid mt-2.5">
          <button v-for="t in ROOM_TYPES" :key="t.id" type="button" class="cell press" :data-type="t.id" @click="addRoom(t.id)">
            <span class="type-icon"><span :class="t.icon" /></span>
            <span class="cell-name">{{ t.name }}</span>
          </button>
        </div>
      </div>
    </van-popup>

    <!-- 让她布置：想要什么 -->
    <van-popup v-model:show="planOpen" position="bottom" round teleport="body">
      <div class="sheet" data-sheet="plan">
        <div class="sheet-title">想让{{ her.pronoun }}怎么布置？</div>
        <div class="text-[12.5px] text-ink-3">可以不写，{{ her.pronoun }}按自己的喜好来；{{ her.pronoun }}一次改几样，放不下的会在附近找空地</div>
        <div class="chips mt-2.5">
          <button v-for="w in WISHES" :key="w" type="button" class="chip-btn" :class="{ on: wish === w }" @click="wish = wish === w ? '' : w">{{ w }}</button>
        </div>
        <input v-model="wish" class="field w-full mt-2.5" placeholder="比如：窗边放张书桌" aria-label="想要什么" @keydown.enter="herPlan" />
        <van-button type="primary" round block class="!mt-3" @click="herPlan">交给{{ her.pronoun }}</van-button>
      </div>
    </van-popup>

    <AvatarEditor v-model:show="avatarOpen" :you="home.you" :her="home.her" :her-name="her.name" :her-pronoun="her.pronoun" :start="avatarWho" :design="design" @save="saveAvatar" />
  </div>
</template>

<style scoped>
.decor {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.warn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.rooms {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.rooms::-webkit-scrollbar {
  display: none;
}
.room-tab {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.room-tab.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
  outline-offset: -1px;
}
.room-tab.add {
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--ink-3);
}
.type-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--surface);
  color: var(--accent-ink);
  font-size: 20px;
}
.danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  height: 38px;
  margin-top: 18px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--bad);
  font-size: 13.5px;
}
.view {
  position: relative;
  flex: 1;
  min-height: 240px;
  border-radius: 20px;
  overflow: hidden;
  background: radial-gradient(110% 80% at 50% 30%, color-mix(in srgb, var(--accent) 10%, var(--surface)), var(--panel));
  border: 1px solid var(--border);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
@supports not (background: color-mix(in srgb, red 10%, transparent)) {
  .view {
    background: var(--panel);
  }
}
.fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  color: var(--ink-3);
  font-size: 13px;
}
.view-top {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.view-top > * {
  pointer-events: auto;
}
.modes {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 99px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
}
.modes button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 99px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.modes button.on {
  background: var(--accent);
  color: var(--on-accent);
}
.round {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  color: var(--ink);
  font-size: 16px;
}
.hint {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  max-width: calc(100% - 16px);
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--glass);
  color: var(--ink-3);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.tools {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.sel {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  touch-action: manipulation;
}
.tool {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  height: 36px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  white-space: nowrap;
}
.tool.icon {
  flex: 0 0 36px;
}
.tool:disabled {
  opacity: 0.4;
}
.tool-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--ink);
  font-size: 16px;
}
.tool-sm.on {
  background: var(--accent);
  border-color: transparent;
  color: var(--on-accent);
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.swatch {
  position: relative;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--border);
}
.swatch.on {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.swatch.custom {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: conic-gradient(#f4b6c2, #f6e09a, #b5dfc9, #a9c4e0, #c9b8e8, #f4b6c2);
  color: #fff;
}
.swatch.custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.her-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 6px;
  margin-top: 10px;
}
.her-row :deep(.van-button) {
  padding: 0 6px;
  white-space: nowrap;
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
.sheet {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 16px calc(var(--safe-bottom) + 16px);
  overflow-y: auto;
}
.sheet .field {
  flex: none;
}
.sheet-title {
  margin-bottom: 8px;
  font-size: 15px;
  font-weight: 600;
}
.label {
  margin: 14px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.chip-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.chip-btn.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.cats {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
}
.cat {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.cat.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  border-radius: 14px;
  background: var(--panel);
}
.thumb {
  width: 72px;
  height: 72px;
  object-fit: contain;
}
.thumb.ph {
  width: 44px;
  height: 44px;
  margin: 14px;
  border-radius: 12px;
  opacity: 0.6;
}
.cell-name {
  font-size: 12.5px;
  color: var(--ink-2);
}
</style>
