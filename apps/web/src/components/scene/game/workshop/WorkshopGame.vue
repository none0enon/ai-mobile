<script setup lang="ts">
import { isWorkshopPreset, type MessagePart, type PresetUseId } from '@app/shared';
import { showConfirmDialog, showImagePreview, showToast } from 'vant';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import AssetImg from '@/components/common/AssetImg.vue';
import { assetUrl } from '@/services/assets';
import { personaOf } from '@/services/prompt';
import { chapterLabel } from '@/services/workshop';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { useWorkshopStore, type Drawing } from '@/stores/workshop';
import { uid } from '@/utils/id';
import DrawStudio from './DrawStudio.vue';
import NovelStudio from './NovelStudio.vue';

/**
 * 一起游戏 · 创意工坊（设计文档 §9.11）：你自己的作品，AI 帮你一起做。
 * - 写小说（NovelStudio）：和写作助手商量设定、写章节和番外，用"创作 · 小说"的 API 和"小说"预设；
 * - 画画（DrawStudio）：你写想画什么，生图提示词智能体按"创意工坊 · 画画"的生图预设写 tags，再调生图 API；
 * - 给她看：挑一章小说或者一张画，选想听她捧场、吐槽还是随她，她看完说说（"一起游戏 · 创意工坊"预设，ws-novel / ws-image，
 *   想听什么另外打开 ws-cheer / ws-roast 那一块）。发一张作品卡片进聊天，她之后聊天也记得。
 * 作品存在本机（stores/workshop），不分角色。离开时那一段写"一起玩了创意工坊（给她看了 N 件作品）"。
 */
export type WorkshopPhase = 'menu' | 'novel' | 'draw';
type Mood = '' | 'cheer' | 'roast';
type Showing = { kind: 'novel'; novelId: string; chapterId: string } | { kind: 'image'; drawingId: string };

const USE: PresetUseId = 'game-workshop';
/** 给她看的一章最多带多少字（太长的截掉后面，告诉她后面还有） */
const SHOW_CHARS = 6000;

const line = defineModel<string>('line', { required: true });
const phase = defineModel<WorkshopPhase>('phase', { required: true });
const emit = defineEmits<{
  fail: [r: { reason: string; notConnected?: boolean }];
  progress: [summary: string | null];
  done: [summary: string];
}>();

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const ws = useWorkshopStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);
const presetReady = computed(() => isWorkshopPreset(lib.presetForUse(USE, her.value)));

const openNovel = ref<string | null>(null);
const busy = ref(false);
const shown = ref(0);
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});

function report() {
  emit('progress', shown.value ? `创意工坊（给${her.value.name}看了 ${shown.value} 件作品）` : null);
}

function fail(r: { reason: string; notConnected?: boolean }) {
  if (alive) emit('fail', r);
}

// —— 作品列表 ——
const newOpen = ref(false);
const draft = ref({ title: '', genre: '', setting: '' });

function startNovel() {
  const d = draft.value;
  const n = ws.createNovel({ title: d.title, genre: d.genre.trim(), setting: d.setting.trim() });
  draft.value = { title: '', genre: '', setting: '' };
  newOpen.value = false;
  edit(n.id);
}

function edit(id: string) {
  openNovel.value = id;
  phase.value = 'novel';
}

function toMenu() {
  phase.value = 'menu';
  openNovel.value = null;
}

const words = (n: { chapters: { text: string }[] }) => n.chapters.reduce((s, c) => s + c.text.replace(/\s/g, '').length, 0);
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 60 / 24)} 天前`;
};

/** 点一张画：看大图 */
async function previewDrawing(d: Drawing) {
  const url = d.assetKey ? await assetUrl(d.assetKey) : d.url;
  if (url) showImagePreview({ images: [url], closeable: true, showIndex: false });
  else showToast('本机找不到这张图了');
}

async function removeDrawing(d: Drawing) {
  const ok = await showConfirmDialog({ title: `删除「${d.title}」？`, confirmButtonText: '删除', confirmButtonColor: 'var(--bad)' }).then(
    () => true,
    () => false,
  );
  if (ok) ws.removeDrawing(d.id);
}

// —— 给她看 ——
const showing = ref<Showing | null>(null);
const mood = ref<Mood>('');
const note = ref('');
const MOODS = computed<{ value: Mood; label: string; icon: string }[]>(() => [
  { value: '', label: `随${her.value.pronoun}`, icon: 'i-lucide-sparkles' },
  { value: 'cheer', label: '想听夸', icon: 'i-lucide-party-popper' },
  { value: 'roast', label: '想听吐槽', icon: 'i-lucide-laugh' },
]);
const showNovel = computed(() => (showing.value?.kind === 'novel' ? ws.novelById(showing.value.novelId) : undefined));
const showChapter = computed(() => (showing.value?.kind === 'novel' ? showNovel.value?.chapters.find((c) => c.id === (showing.value as { chapterId: string }).chapterId) : undefined));
const showDrawing = computed(() => (showing.value?.kind === 'image' ? ws.drawings.find((d) => d.id === (showing.value as { drawingId: string }).drawingId) : undefined));

function openShow(s: Showing) {
  if (!chatId.value) return showToast(`还没有和${her.value.name}的聊天`);
  mood.value = '';
  note.value = '';
  showing.value = s;
}

/** 场景任务：这一次给她看的作品 */
function showInput(): { task: string; input: string; card: MessagePart } | null {
  const s = showing.value;
  if (!s) return null;
  const moodLine = mood.value === 'cheer' ? `${userName.value}想听你夸` : mood.value === 'roast' ? `${userName.value}想听你吐槽` : `${userName.value}没说想听夸还是吐槽，看你自己`;
  if (s.kind === 'novel') {
    const n = showNovel.value;
    const c = showChapter.value;
    if (!n || !c) return null;
    const text = c.text.length > SHOW_CHARS ? `${c.text.slice(0, SHOW_CHARS)}\n（后面还有 ${c.text.length - SHOW_CHARS} 字，${userName.value}只给你看到这里）` : c.text;
    const label = chapterLabel(n, c);
    return {
      task: 'ws-novel',
      input: [
        `${userName.value}给你看的：小说《${n.title}》${n.genre ? `（${n.genre}）` : ''}的【${label}】`,
        n.setting.trim() ? `这部小说的设定（${userName.value}写的）：${n.setting.trim().replace(/\s+/g, ' ').slice(0, 500)}` : '',
        `一共写了 ${n.chapters.length} 篇，这是其中一篇`,
        moodLine,
        `全文：\n# ${c.title}\n\n${text}`,
      ]
        .filter(Boolean)
        .join('\n'),
      card: {
        type: 'game',
        logId: uid('game'),
        game: 'workshop',
        kind: 'novel',
        title: n.title,
        chapter: label,
        excerpt: c.text.replace(/\s+/g, ' ').slice(0, 60),
        ...(mood.value ? { verdict: mood.value } : {}),
      },
    };
  }
  const d = showDrawing.value;
  if (!d) return null;
  const from = d.novelId ? ws.novelById(d.novelId) : undefined;
  const subject = d.who === 'her' && d.characterId === her.value.id ? '画的是你' : d.who === 'her' ? `画的是${chars.byId(d.characterId)?.name ?? '别的角色'}` : from ? `画的是${userName.value}的小说《${from.title}》里的东西` : '自由画';
  return {
    task: 'ws-image',
    input: [`${userName.value}给你看一张画：「${d.title}」`, subject, `${userName.value}写的画面描述：${d.caption}`, `生图用的 tags（画出来大概就是这样）：${d.prompt}`, moodLine].join('\n'),
    card: { type: 'game', logId: uid('game'), game: 'workshop', kind: 'image', title: d.title, ...(d.assetKey ? { photo: d.assetKey } : {}), ...(mood.value ? { verdict: mood.value } : {}) },
  };
}

async function herReply(task: string, input: string, userText: string | undefined, flags: string[], cue: string): Promise<boolean> {
  busy.value = true;
  line.value = '';
  try {
    const r = await chat.sceneReply(chatId.value, {
      task,
      input: `你们在一起游戏的"创意工坊"里。\n${input}`,
      userText,
      cue,
      use: USE,
      flags,
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

async function sendShow() {
  const s = showInput();
  if (!s || busy.value) return;
  const said = note.value.trim();
  const flags = mood.value === 'cheer' ? ['ws-cheer'] : mood.value === 'roast' ? ['ws-roast'] : [];
  showing.value = null;
  chat.postCard(chatId.value, 'user', s.card);
  shown.value += 1;
  report();
  const title = s.card.type === 'game' && s.card.game === 'workshop' ? s.card.title : '作品';
  await herReply(s.task, s.input, said || undefined, flags, `给${her.value.pronoun}看「${title}」`);
}

// —— 聊聊创作 ——
const talkText = ref('');
async function talk() {
  const t = talkText.value.trim();
  if (!t || busy.value || !chatId.value) return;
  talkText.value = '';
  const works = [
    ws.novels.length ? `${userName.value}在写的小说：${ws.novels.slice(0, 5).map((n) => `《${n.title}》（${n.chapters.length} 篇）`).join('、')}` : `${userName.value}还没开始写小说`,
    ws.drawings.length ? `画过 ${ws.drawings.length} 张画，最近一张是「${ws.drawings[0]!.title}」` : '',
  ].filter(Boolean);
  await herReply('ws-chat', works.join('\n'), t, [], '聊聊创作');
}
</script>

<template>
  <div class="workshop" data-game="workshop">
    <div v-if="!presetReady" class="warn">
      <span class="i-lucide-triangle-alert shrink-0" />
      <span class="flex-1 min-w-0">"一起游戏 · 创意工坊"选的预设里没有创意工坊的几步，{{ her.pronoun }}看作品时可能不知道要做什么</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/presets')">去看看</button>
    </div>

    <NovelStudio v-if="phase === 'novel' && openNovel && ws.novelById(openNovel)" :novel-id="openNovel" :character="her" :user-name="userName" @back="toMenu" @show="(cid: string) => openShow({ kind: 'novel', novelId: openNovel!, chapterId: cid })" />
    <DrawStudio v-else-if="phase === 'draw'" :character="her" @back="toMenu" @show="(id: string) => openShow({ kind: 'image', drawingId: id })" />

    <!-- 作品列表 -->
    <template v-else>
      <div class="scroll">
        <div class="text-[15px] font-600">创意工坊</div>
        <div class="text-[12.5px] text-ink-3 mt-0.5">和 AI 一起写小说、画画；写好画好拿给{{ her.name }}看，听{{ her.pronoun }}捧场或者吐槽</div>

        <div class="sec">
          <span class="i-lucide-feather text-accent-ink" />
          <span class="flex-1 font-600 text-[14px]">我的小说</span>
          <button type="button" class="add press" @click="newOpen = true"><span class="i-lucide-plus" />新建</button>
        </div>
        <div v-if="!ws.novels.length" class="empty" @click="newOpen = true">还没有小说。点"新建"，起个名字就能开始和写作助手商量。</div>
        <button v-for="n in ws.novels" :key="n.id" type="button" class="novel press" @click="edit(n.id)">
          <span class="cover"><span class="i-lucide-book-open-text" /></span>
          <span class="flex-1 min-w-0">
            <span class="block truncate text-[14.5px] font-600">《{{ n.title }}》</span>
            <span class="block truncate text-[12px] text-ink-3">{{ [n.genre, `${n.chapters.length} 篇`, `${words(n)} 字`, ago(n.updatedAt)].filter(Boolean).join(' · ') }}</span>
          </span>
          <span class="i-lucide-chevron-right text-ink-3 shrink-0" />
        </button>

        <div class="sec">
          <span class="i-lucide-palette text-accent-ink" />
          <span class="flex-1 font-600 text-[14px]">我的画</span>
          <button type="button" class="add press" @click="phase = 'draw'"><span class="i-lucide-plus" />画一张</button>
        </div>
        <div v-if="!ws.drawings.length" class="empty" @click="phase = 'draw'">还没有画。写一句想画什么，生图 AI 帮你写提示词、画出来。</div>
        <div v-else class="grid">
          <div v-for="d in ws.drawings" :key="d.id" class="tile">
            <button type="button" class="thumb" :aria-label="`看大图：${d.title}`" @click="previewDrawing(d)">
              <AssetImg :asset-key="d.assetKey" :url="d.url" :alt="d.title" />
            </button>
            <div class="t-title truncate">{{ d.title }}</div>
            <div class="t-acts">
              <button type="button" class="t-btn on" @click="openShow({ kind: 'image', drawingId: d.id })"><span class="i-lucide-eye" />给{{ her.pronoun }}看</button>
              <button type="button" class="t-btn" :aria-label="`删除：${d.title}`" @click="removeDrawing(d)"><span class="i-lucide-trash-2" /></button>
            </div>
          </div>
        </div>
      </div>

      <div class="composer">
        <input v-model="talkText" class="field" :placeholder="`和${her.name}聊聊创作…`" :aria-label="`和${her.name}聊聊创作`" :disabled="busy" @keydown.enter.prevent="talk" />
        <button type="button" class="send" aria-label="发送" :disabled="busy || !talkText.trim()" @click="talk"><span class="i-lucide-arrow-up" /></button>
      </div>
    </template>

    <!-- 新建小说 -->
    <van-popup v-model:show="newOpen" position="bottom" round teleport="body">
      <div class="sheet">
        <div class="text-[15px] font-600">新建一部小说</div>
        <input v-model="draft.title" class="field mt-3" placeholder="书名（之后能改）" aria-label="书名" />
        <input v-model="draft.genre" class="field mt-2" placeholder="类型：校园恋爱、仙侠、悬疑……（可以不写）" aria-label="类型" />
        <textarea v-model="draft.setting" class="area mt-2" rows="3" placeholder="一句话说说想写什么（可以不写，之后和写作助手慢慢聊）" aria-label="想写什么" />
        <van-button type="primary" round block class="!mt-3" @click="startNovel">开始</van-button>
      </div>
    </van-popup>

    <!-- 给她看 -->
    <van-popup :show="!!showing" position="bottom" round teleport="body" @update:show="(v: boolean) => !v && (showing = null)">
      <div class="sheet">
        <div class="text-[15px] font-600">给{{ her.name }}看</div>
        <div v-if="showChapter && showNovel" class="peek">
          <div class="text-[13px] text-ink-3">《{{ showNovel.title }}》</div>
          <div class="text-[14.5px] font-600 mt-0.5">{{ chapterLabel(showNovel, showChapter) }}</div>
          <div class="excerpt">{{ showChapter.text.slice(0, 120) }}…</div>
        </div>
        <div v-else-if="showDrawing" class="peek row">
          <span class="mini"><AssetImg :asset-key="showDrawing.assetKey" :url="showDrawing.url" :alt="showDrawing.title" /></span>
          <span class="flex-1 min-w-0">
            <span class="block text-[14.5px] font-600 truncate">{{ showDrawing.title }}</span>
            <span class="block text-[12.5px] text-ink-3 line-clamp-2">{{ showDrawing.caption }}</span>
          </span>
        </div>
        <div class="text-[12.5px] text-ink-2 mt-3">想听{{ her.pronoun }}说什么</div>
        <div class="moods">
          <button v-for="m in MOODS" :key="m.value" type="button" class="mood press" :class="{ on: mood === m.value }" @click="mood = m.value"><span :class="m.icon" />{{ m.label }}</button>
        </div>
        <input v-model="note" class="field mt-3" :placeholder="`想对${her.pronoun}说的（可以不写）`" aria-label="想对她说的" />
        <van-button type="primary" round block class="!mt-3" :disabled="busy" @click="sendShow">给{{ her.pronoun }}看</van-button>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.workshop {
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
.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.sec {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 16px 0 8px;
}
.add {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12.5px;
}
.empty {
  padding: 14px 12px;
  border-radius: 14px;
  border: 1px dashed var(--border);
  color: var(--ink-3);
  font-size: 12.5px;
  line-height: 1.6;
}
.novel {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin-bottom: 8px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  text-align: left;
}
.cover {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 46px;
  border-radius: 6px 10px 10px 6px;
  background: color-mix(in srgb, #7fc8a9 26%, var(--panel));
  color: #4e9c7c;
  font-size: 18px;
}
@supports not (background: color-mix(in srgb, red 10%, transparent)) {
  .cover {
    background: var(--accent-soft);
  }
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.tile {
  min-width: 0;
  padding: 6px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.thumb {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 10px;
  background: var(--bg-2);
}
.t-title {
  margin-top: 4px;
  font-size: 13px;
}
.t-acts {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.t-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 26px;
  padding: 0 8px;
  border-radius: 99px;
  font-size: 12px;
  color: var(--ink-3);
}
.t-btn.on {
  flex: 1;
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.composer {
  display: flex;
  flex: none;
  gap: 8px;
  margin-top: 10px;
}
.field {
  flex: 1;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 12px;
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
  font-size: 14px;
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
.send {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 18px;
}
.send:disabled {
  opacity: 0.4;
}
.sheet {
  padding: 18px 16px calc(var(--safe-bottom, 0px) + 16px);
}
.peek {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
.peek.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mini {
  display: block;
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  overflow: hidden;
  border-radius: 10px;
}
.excerpt {
  margin-top: 4px;
  font-family: var(--font-serif);
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-2);
}
.moods {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 6px;
}
.mood {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 36px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  font-size: 13px;
  color: var(--ink-2);
}
.mood.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
</style>
