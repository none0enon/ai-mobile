<script setup lang="ts">
import { errorText } from '@app/ai';
import { isExpression, type MessagePart } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import SceneShell from '@/components/scene/SceneShell.vue';
import { services } from '@/services';
import { chaptersFromText, imageFileData, parseEpub, parsePdf, parseTxt, readImageText, renderPdfPage, scanPageOf, type Book, type BookChapter, type BookFormat } from '@/services/books';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useBookStore } from '@/stores/books';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';

/**
 * 一起看书（设计文档 §9.10）：EPUB、TXT、PDF、粘贴的文章、拍下的书页。
 * 她提前"读"好接下来几页，批量写页边批注（挂在段落上，翻到才显示，显示时存进聊天）；
 * 你划一句、写一句，她回你；读完一章她聊两句；她也能用自己的声音读给你听。
 * 她说的话都来自「陪伴 · 快速」（"一起看书"功能预设 + 这一次的输入）；扫描页交给"识图"读，读法也写在这个预设里。
 */
type Talk = 'quiet' | 'normal' | 'chatty';
const TALK: Record<Talk, { label: string; hint: string }> = {
  quiet: { label: '安静', hint: '这几页最多 1 条' },
  normal: { label: '适中', hint: '这几页 1–3 条' },
  chatty: { label: '话痨', hint: '这几页 3–5 条' },
};
/** 一页大约多少字 */
const PAGE_CHARS = 600;

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const shelf = useBookStore();
const lib = useLibraryStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

const book = ref<Book | null>(null);
const talk = ref<Talk>('normal');
const notConnected = ref('');
const herLine = ref('');
const busy = ref('');
const replying = computed(() => !!chat.streams[chatId.value]);

function fail(r: { reason: string; notConnected?: boolean }) {
  if (r.notConnected) notConnected.value = r.reason;
  else showToast(r.reason);
}

// —— 导入 ——
const stem = (n: string) => n.replace(/\.[^.]+$/, '');
function newBook(title: string, format: BookFormat, chapters: BookChapter[]): Book {
  const now = Date.now();
  return { id: uid('book'), title: title || '没有书名', format, chapters, createdAt: now, updatedAt: now, pos: { chapter: 0, para: 0 }, notes: [] };
}
async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!file) return;
  busy.value = `正在读《${stem(file.name)}》…`;
  try {
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') {
      const r = await parsePdf(file, async () => window.prompt('这个 PDF 有密码，请输入：'));
      shelf.add(newBook(r.title || stem(file.name), 'pdf', r.chapters), file);
    } else if (ext === 'epub') {
      const r = await parseEpub(file);
      shelf.add(newBook(r.title || stem(file.name), 'epub', r.chapters));
    } else if (ext === 'txt') {
      shelf.add(newBook(stem(file.name), 'txt', await parseTxt(file)));
    } else showToast('只认 EPUB、TXT、PDF');
  } catch (err) {
    showToast(`读不出来：${errorText(err)}`);
  } finally {
    busy.value = '';
  }
}
const pasteOpen = ref(false);
const pasteTitle = ref('');
const pasteText = ref('');
function addPasted() {
  const chapters = chaptersFromText(pasteText.value);
  if (!chapters.length) return showToast('先粘贴正文');
  shelf.add(newBook(pasteTitle.value.trim() || '粘贴的文章', 'paste', chapters));
  pasteOpen.value = false;
  pasteText.value = '';
  pasteTitle.value = '';
}
/** 识图读书页的说明在"一起看书"功能预设里 */
function ocrInstruction(): string {
  const text = lib.presetForUse('scene:read', her.value)?.blocks.find((b) => b.identifier === 'readOcr')?.content.trim() ?? '';
  if (!text) throw new Error('"一起看书"预设里没有"识图读书页"这一块');
  return text;
}
async function onPhotos(e: Event) {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  (e.target as HTMLInputElement).value = '';
  if (!files.length) return;
  busy.value = `识图正在读 ${files.length} 页…`;
  try {
    const instruction = ocrInstruction();
    const chapters: BookChapter[] = [];
    for (const [i, f] of files.entries()) chapters.push({ title: `第 ${i + 1} 页`, paras: await readImageText(await imageFileData(f), instruction) });
    shelf.add(newBook(`拍的书页 ${new Date().toLocaleDateString()}`, 'photo', chapters));
  } catch (err) {
    showToast(errorText(err));
  } finally {
    busy.value = '';
  }
}

// —— 分页：一章按字数切成页 ——
const chapter = computed(() => book.value?.chapters[book.value.pos.chapter]);
function pagesOf(c: BookChapter): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let size = 0;
  c.paras.forEach((p, i) => {
    if (!out.length || size + p.length > PAGE_CHARS) {
      out.push({ from: i, to: i + 1 });
      size = 0;
    } else out.at(-1)!.to = i + 1;
    size += p.length;
  });
  return out;
}
const pages = computed(() => (chapter.value ? pagesOf(chapter.value) : []));
const pageIndex = computed(() => Math.max(0, pages.value.findIndex((p) => book.value!.pos.para >= p.from && book.value!.pos.para < p.to)));
const page = computed(() => pages.value[pageIndex.value]);
const progress = computed(() => {
  const b = book.value;
  if (!b) return 0;
  const total = b.chapters.reduce((n, c) => n + c.paras.length, 0) || 1;
  const before = b.chapters.slice(0, b.pos.chapter).reduce((n, c) => n + c.paras.length, 0) + (page.value?.to ?? 0);
  return Math.min(100, Math.round((before / total) * 100));
});
const sessionNotes = ref(0);
const lastQuote = ref('');

function open(b: Book) {
  book.value = b;
  pending.clear();
  requested.clear();
  herLine.value = '';
  sessionNotes.value = 0;
  onPageShown();
}
function goPage(i: number) {
  const b = book.value;
  if (!b || !pages.value[i]) return;
  b.pos.para = pages.value[i]!.from;
  b.updatedAt = Date.now();
  onPageShown();
}
async function nextPage() {
  const b = book.value;
  if (!b) return;
  if (pageIndex.value < pages.value.length - 1) return goPage(pageIndex.value + 1);
  // 一章读完了：她聊两句，再翻到下一章
  const done = chapter.value!;
  void chapterEnd(done.title);
  if (b.pos.chapter < b.chapters.length - 1) {
    b.pos = { chapter: b.pos.chapter + 1, para: 0 };
    b.updatedAt = Date.now();
    onPageShown();
  } else showToast('读完了这本书');
}
function prevPage() {
  const b = book.value;
  if (!b) return;
  if (pageIndex.value > 0) return goPage(pageIndex.value - 1);
  if (b.pos.chapter > 0) {
    b.pos.chapter -= 1;
    const ps = pagesOf(b.chapters[b.pos.chapter]!);
    b.pos.para = ps.at(-1)?.from ?? 0;
    onPageShown();
  }
}
const tocOpen = ref(false);
function goChapter(i: number) {
  if (!book.value) return;
  book.value.pos = { chapter: i, para: 0 };
  tocOpen.value = false;
  onPageShown();
}

// —— 她的页边批注：提前写好接下来几页，翻到才显示 ——
const pending = new Map<string, { quote: string; note: string; expr?: string }>();
const requested = new Set<string>();
const cueOf = (c: number, p: number, quote?: string) => `${book.value?.chapters[c]?.title ?? ''} 第 ${p + 1} 段${quote ? `「${quote.slice(0, 20)}」` : ''}`;

function onPageShown() {
  const b = book.value;
  if (!b) return;
  // 这一页上已经写好的批注：显示出来，存进聊天
  const pg = page.value;
  if (pg) {
    for (let p = pg.from; p < pg.to; p += 1) {
      const key = `${b.id}:${b.pos.chapter}:${p}`;
      const n = pending.get(key);
      if (!n) continue;
      pending.delete(key);
      b.notes = [...(b.notes ?? []), { chapter: b.pos.chapter, para: p, who: 'her', quote: n.quote, text: n.note, at: Date.now() }];
      chat.push(chatId.value, 'assistant', [{ type: 'text', text: n.note }], { meta: { scene: 'read', cue: cueOf(b.pos.chapter, p, n.quote), agent: 'companion' }, expression: n.expr ?? null });
      if (n.expr) chars.setExpression(her.value.id, n.expr);
      herLine.value = n.note;
    }
  }
  void requestNotes(pageIndex.value);
}

async function requestNotes(from: number) {
  const b = book.value;
  const c = chapter.value;
  if (!b || !c || notConnected.value) return;
  const ps = pagesOf(c).slice(from, from + 3).filter((_, i) => !requested.has(`${b.id}:${b.pos.chapter}:${from + i}`));
  if (!ps.length) return;
  ps.forEach((_, i) => requested.add(`${b.id}:${b.pos.chapter}:${from + i}`));
  const chapterNo = b.pos.chapter;
  const paras = ps.flatMap((p) => c.paras.slice(p.from, p.to).map((text, k) => ({ i: p.from + k, text }))).filter((x) => scanPageOf(x.text) === null);
  if (!paras.length) return;
  const valid = new Set(paras.map((x) => x.i));
  const r = await chat.sceneJson(
    chatId.value,
    {
      name: 'read-batch',
      input: [
        `书名：《${b.title}》`,
        `这一章：${c.title}`,
        `前情提要：${b.summary || '（刚开始读）'}`,
        `话量：${TALK[talk.value].label}（${TALK[talk.value].hint}）`,
        '接下来几页的段落（编号 正文）：',
        ...paras.map((x) => `#${x.i} ${x.text.slice(0, 400)}`),
      ].join('\n'),
    },
    (v) => {
      const o = v as { notes?: unknown; summary?: unknown } | null;
      if (!o || !Array.isArray(o.notes)) return null;
      const notes = o.notes
        .map((x) => x as { para?: unknown; quote?: unknown; note?: unknown; expr?: unknown })
        .filter((x) => valid.has(Number(x.para)) && typeof x.note === 'string' && x.note.trim())
        .map((x) => ({ para: Number(x.para), quote: typeof x.quote === 'string' ? x.quote.trim().slice(0, 80) : '', note: String(x.note).trim().slice(0, 80), ...(typeof x.expr === 'string' && isExpression(x.expr) ? { expr: x.expr } : {}) }));
      return { notes, summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 600) : '' };
    },
  );
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else ps.forEach((_, i) => requested.delete(`${b.id}:${chapterNo}:${from + i}`));
    return;
  }
  if (r.value.summary && book.value === b) b.summary = r.value.summary;
  for (const n of r.value.notes) pending.set(`${b.id}:${chapterNo}:${n.para}`, { quote: n.quote, note: n.note, expr: n.expr });
  // 刚好就在这一页：马上显示
  if (book.value === b && b.pos.chapter === chapterNo) onPageShown();
}

// —— 你划一句、写一句 ——
const noteOpen = ref(false);
const notePara = ref(0);
const noteQuote = ref('');
const noteText = ref('');
function openNote(p: number) {
  const sel = window.getSelection()?.toString().trim() ?? '';
  notePara.value = p;
  noteQuote.value = sel && chapter.value?.paras[p]?.includes(sel) ? sel : '';
  noteText.value = '';
  noteOpen.value = true;
}
async function saveNote() {
  const b = book.value;
  const c = chapter.value;
  const text = noteText.value.trim();
  if (!b || !c || !text) return;
  noteOpen.value = false;
  const p = notePara.value;
  const quote = noteQuote.value.trim();
  b.notes = [...(b.notes ?? []), { chapter: b.pos.chapter, para: p, who: 'you', quote, text, at: Date.now() }];
  sessionNotes.value += 1;
  if (quote) lastQuote.value = quote;
  const r = await chat.sceneReply(chatId.value, {
    task: 'read-note',
    input: [`书名：《${b.title}》`, `${c.title} 第 ${p + 1} 段：${c.paras[p]?.slice(0, 400)}`, quote ? `${userName.value}划了：「${quote}」` : ''].filter(Boolean).join('\n'),
    userText: text,
    cue: cueOf(b.pos.chapter, p, quote),
  });
  if (!r.ok) return fail(r);
  b.notes = [...(b.notes ?? []), { chapter: b.pos.chapter, para: p, who: 'her', text: r.message.text, at: Date.now() }];
  herLine.value = r.message.text;
}

async function chapterEnd(title: string) {
  const b = book.value;
  if (!b) return;
  const r = await chat.sceneReply(chatId.value, { task: 'read-chapter-end', input: [`书名：《${b.title}》`, `刚读完：${title}`, `前情提要：${b.summary || '（没有）'}`].join('\n'), cue: `读完${title}` });
  if (r.ok) herLine.value = r.message.text;
  else fail(r);
}

const chatText = ref('');
async function sendChat() {
  const b = book.value;
  const text = chatText.value.trim();
  if (!b || !text) return;
  chatText.value = '';
  const r = await chat.sceneReply(chatId.value, { task: 'read-chat', input: [`书名：《${b.title}》`, `读到：${chapter.value?.title ?? ''}（全书 ${progress.value}%）`, `前情提要：${b.summary || '（刚开始读）'}`].join('\n'), userText: text, cue: cueOf(b.pos.chapter, b.pos.para) });
  if (r.ok) herLine.value = r.message.text;
  else fail(r);
}

// —— 读给你听：用她的声音一段一段念，念到哪段亮哪段 ——
const speakingPara = ref<number | null>(null);
let stopSpeaking = false;
async function readAloud(from: number) {
  const c = chapter.value;
  if (!c) return;
  stopSpeaking = false;
  for (let p = from; p < c.paras.length && !stopSpeaking; p += 1) {
    const text = c.paras[p]!;
    if (scanPageOf(text) !== null) continue;
    speakingPara.value = p;
    if (page.value && p >= page.value.to) goPage(pageIndex.value + 1);
    try {
      await services.tts.speak(text, { characterId: her.value.id });
    } catch (err) {
      showToast(errorText(err));
      break;
    }
  }
  speakingPara.value = null;
}
function stopAloud() {
  stopSpeaking = true;
  services.tts.stop();
  speakingPara.value = null;
}

// —— 扫描页交给识图读 ——
async function ocrPage(paraIndex: number, pageNo: number) {
  const b = book.value;
  const c = chapter.value;
  if (!b || !c) return;
  busy.value = `识图正在读第 ${pageNo} 页…`;
  try {
    const file = await shelf.fileOf(b.id);
    if (!file) throw new Error('找不到这本 PDF 的原文件，重新导入一次试试');
    const lines = await readImageText(await renderPdfPage(file, pageNo), ocrInstruction());
    c.paras.splice(paraIndex, 1, ...lines);
    c.pages?.splice(paraIndex, 1, ...lines.map(() => pageNo));
    b.updatedAt = Date.now();
  } catch (err) {
    showToast(errorText(err));
  } finally {
    busy.value = '';
  }
}

// —— 今天读到这里 ——
function finish() {
  const b = book.value;
  if (!b || !chatId.value) return;
  stopAloud();
  const card: MessagePart = { type: 'read', logId: uid('read'), title: b.title, chapter: chapter.value?.title ?? '', progress: progress.value, notes: sessionNotes.value, ...(lastQuote.value ? { quote: lastQuote.value } : {}) };
  chat.postCard(chatId.value, 'user', card);
  chat.leaveScene(her.value.id, `一起读了《${b.title}》`);
  void router.push(`/chat/${chatId.value}`);
}
const notesOn = (p: number) => (book.value?.notes ?? []).filter((n) => n.chapter === book.value!.pos.chapter && n.para === p);
</script>

<template>
  <SceneShell scene-id="read" :hide-figure="!!book" pose="sit" :line="herLine" :typing="replying && !herLine" :title="book ? `《${book.title}》` : undefined" :layout="{ left: 78, bottom: 56, height: 30 }">
    <div v-if="notConnected" class="notice">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ notConnected }}</span>
      <button class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>
    <div v-if="busy" class="notice"><van-loading size="14px" />{{ busy }}</div>

    <!-- 书架 -->
    <template v-if="!book">
      <div class="text-[15px] font-600">我们的书架</div>
      <button v-for="b in shelf.books" :key="b.id" type="button" class="book press" @click="open(b)">
        <span class="i-lucide-book text-[20px] text-accent-ink shrink-0" />
        <span class="flex-1 min-w-0 text-left">
          <span class="block truncate text-[14.5px]">{{ b.title }}</span>
          <span class="block truncate text-[12px] text-ink-3">{{ b.format.toUpperCase() }} · {{ b.chapters.length }} 章 · 读到{{ b.chapters[b.pos.chapter]?.title }}</span>
        </span>
        <button type="button" class="text-ink-3 px-1" aria-label="从书架上拿走" @click.stop="shelf.remove(b.id)"><span class="i-lucide-trash-2" /></button>
      </button>
      <div v-if="!shelf.books.length" class="text-[12.5px] text-ink-3 mt-2">书架还是空的。书只存在这台设备上，发给模型的只有当前这几页。</div>
      <div class="grid grid-cols-3 gap-2 mt-3">
        <label class="add press"><span class="i-lucide-file-up text-[20px]" />EPUB / TXT / PDF<input type="file" class="hidden" accept=".epub,.txt,.pdf" @change="onFile" /></label>
        <button type="button" class="add press" @click="pasteOpen = true"><span class="i-lucide-clipboard-paste text-[20px]" />粘贴文章</button>
        <label class="add press"><span class="i-lucide-camera text-[20px]" />拍书页<input type="file" class="hidden" accept="image/*" capture="environment" multiple @change="onPhotos" /></label>
      </div>
    </template>

    <!-- 读 -->
    <template v-else>
      <div class="flex items-center gap-2 text-[12.5px] text-ink-3">
        <button type="button" class="truncate text-accent-ink" @click="tocOpen = true">{{ chapter?.title }}</button>
        <span class="shrink-0 num">{{ pageIndex + 1 }} / {{ pages.length }} · 全书 {{ progress }}%</span>
        <span class="flex-1" />
        <button type="button" class="shrink-0" @click="book = null">书架</button>
      </div>
      <div class="paper">
        <template v-for="p in page ? Array.from({ length: page.to - page.from }, (_, k) => page!.from + k) : []" :key="p">
          <div v-if="scanPageOf(chapter!.paras[p]!) !== null" class="scan">
            第 {{ scanPageOf(chapter!.paras[p]!) }} 页没有文字层（扫描版或乱码）
            <van-button size="mini" round @click="ocrPage(p, scanPageOf(chapter!.paras[p]!)!)">交给识图读</van-button>
          </div>
          <p v-else class="para" :class="{ speaking: speakingPara === p }" @click="openNote(p)">{{ chapter!.paras[p] }}</p>
          <div v-for="(n, k) in notesOn(p)" :key="k" class="margin" :class="n.who">
            <span v-if="n.quote" class="q">「{{ n.quote }}」</span>{{ n.who === 'her' ? `${her.name}：` : '我：' }}{{ n.text }}
          </div>
        </template>
      </div>
      <div class="flex gap-2 mt-2 btns">
        <van-button size="small" round block @click="prevPage">上一页</van-button>
        <van-button v-if="speakingPara === null" size="small" round block @click="readAloud(page?.from ?? 0)">读给我听</van-button>
        <van-button v-else size="small" round block @click="stopAloud">停</van-button>
        <van-button size="small" type="primary" round block @click="nextPage">下一页</van-button>
      </div>
      <div class="flex gap-2 mt-2">
        <input v-model="chatText" class="field" :placeholder="`和${her.pronoun}聊聊这本书（点一段可以写批注）`" aria-label="聊这本书" @keydown.enter="sendChat" />
        <van-button size="small" round :disabled="replying" @click="sendChat">发送</van-button>
      </div>
      <div class="flex items-center gap-2 mt-2">
        <span class="text-[12.5px] text-ink-3">批注话量</span>
        <button v-for="(v, k) in TALK" :key="k" type="button" class="chip" :class="{ on: talk === k }" @click="talk = k">{{ v.label }}</button>
        <span class="flex-1" />
        <van-button size="small" round @click="finish">今天读到这里</van-button>
      </div>
    </template>

    <van-popup v-model:show="pasteOpen" position="bottom" round :style="{ height: '70%' }">
      <div class="p-4 flex flex-col gap-2 h-full">
        <div class="text-[15px] font-600">粘贴一篇文章</div>
        <input v-model="pasteTitle" class="field !flex-none" placeholder="标题" aria-label="标题" />
        <textarea v-model="pasteText" class="area flex-1" placeholder="把正文粘贴到这里" aria-label="正文" />
        <van-button type="primary" round block @click="addPasted">放上书架</van-button>
      </div>
    </van-popup>
    <van-popup v-model:show="noteOpen" position="bottom" round>
      <div class="p-4">
        <div class="text-[15px] font-600 mb-2">写一句批注</div>
        <input v-model="noteQuote" class="field w-full" placeholder="划哪一句（可以先在正文里选中再点）" aria-label="划的句子" />
        <textarea v-model="noteText" class="area mt-2" rows="3" placeholder="你的想法" aria-label="批注" />
        <van-button type="primary" round block class="!mt-2" @click="saveNote">写上</van-button>
      </div>
    </van-popup>
    <van-popup v-model:show="tocOpen" position="bottom" round :style="{ maxHeight: '70%' }">
      <div class="p-4">
        <div class="text-[15px] font-600 mb-2">目录</div>
        <button v-for="(c, i) in book?.chapters ?? []" :key="i" type="button" class="toc" :class="{ on: i === book?.pos.chapter }" @click="goChapter(i)">{{ c.title }}</button>
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
.book {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 2px;
  border-bottom: 1px solid var(--border);
}
.add {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 4px;
  border-radius: 14px;
  background: var(--panel);
  font-size: 12.5px;
  text-align: center;
}
.paper {
  max-height: 46vh;
  overflow-y: auto;
  margin-top: 8px;
  padding: 4px 2px;
}
.para {
  margin: 0 0 10px;
  font-size: 15.5px;
  line-height: 1.8;
  text-indent: 2em;
}
.para.speaking {
  background: var(--accent-soft);
  border-radius: 6px;
}
.margin {
  margin: -4px 0 10px 1.5em;
  padding: 4px 10px;
  border-left: 2px solid var(--accent-line);
  font-size: 13px;
  color: var(--ink-2);
}
.margin.her {
  font-style: italic;
  color: var(--accent-ink);
}
.margin .q {
  color: var(--ink-3);
  margin-right: 4px;
}
.scan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 13px;
  color: var(--ink-2);
}
.btns :deep(.van-button) {
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
.chip {
  height: 26px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  white-space: nowrap;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.toc {
  display: block;
  width: 100%;
  padding: 8px 2px;
  text-align: left;
  font-size: 14px;
  border-bottom: 1px solid var(--border);
}
.toc.on {
  color: var(--accent-ink);
  font-weight: 600;
}
</style>
