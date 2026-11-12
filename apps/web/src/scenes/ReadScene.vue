<script setup lang="ts">
import { errorText } from '@app/ai';
import { clipRich, isExpression, repairJsonLatex, type MessagePart } from '@app/shared';
import { showToast } from 'vant';
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import RichText from '@/components/common/RichText.vue';
import PdfPage from '@/components/scene/PdfPage.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { services } from '@/services';
import {
  chaptersFromText,
  closePdf,
  imageFileData,
  parseEpub,
  parsePdf,
  parseTxt,
  pdfPageImage,
  readPageText,
  rememberPdfPassword,
  scanFallbackOf,
  scanPageOf,
  type Book,
  type BookChapter,
  type BookFormat,
  type BookView,
} from '@/services/books';
import { personaOf } from '@/services/prompt';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useBookStore } from '@/stores/books';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';
import { paraKind, selectionSource } from '@/utils/math';

/**
 * 一起看书（设计文档 §9.10）：EPUB、TXT、PDF、粘贴的文章、拍下的书页。
 * 她提前"读"好接下来几页，批量写页边批注（挂在段落上，翻到才显示，显示时存进聊天）；
 * 你划一句、写一句，她回你；读完一章她聊两句；她也能用自己的声音读给你听。
 * 她说的话都来自「陪伴 · 快速」（"一起看书"功能预设 + 这一次的输入）；扫描页、有公式的页交给"识图"读，读法也写在这个预设里。
 *
 * 带公式的专业书（教材、讲义、论文；参考 math-reader 和 SleepTogether 的看书）：
 * - PDF 两种看法：原版页面（pdf.js 原样画，公式、插图和书上一样）、重排成文字；
 * - 扫描页、有公式的页：识图提前把现在这页和后面两页读成 Markdown + LaTeX，读好之前这一页先原样显示；
 * - 公式用 KaTeX 显示（正文、批注、她的话、聊天里都是），读给你听时公式念成中文。
 */
type Talk = 'quiet' | 'normal' | 'chatty';
const TALK: Record<Talk, { label: string; hint: string }> = {
  quiet: { label: '安静', hint: '这几页最多 1 条' },
  normal: { label: '适中', hint: '这几页 1–3 条' },
  chatty: { label: '话痨', hint: '这几页 3–5 条' },
};
/** 一页大约多少字 */
const PAGE_CHARS = 600;
/** 原版页面的缩放（手机上整页太小时放大，左右滑着看） */
const ZOOMS = [1, 1.5, 2];

const app = useAppStore();
const ai = useAiStore();
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
const visionLive = computed(() => ai.isLive('vision'));

function fail(r: { reason: string; notConnected?: boolean }) {
  if (r.notConnected) notConnected.value = r.reason;
  else showToast(r.reason);
}

// —— 导入 ——
const stem = (n: string) => n.replace(/\.[^.]+$/, '');
function newBook(title: string, format: BookFormat, chapters: BookChapter[], extra: Partial<Book> = {}): Book {
  const now = Date.now();
  return { id: uid('book'), title: title || '没有书名', format, chapters, createdAt: now, updatedAt: now, pos: { chapter: 0, para: 0 }, notes: [], ...extra };
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
      const b = newBook(r.title || stem(file.name), 'pdf', r.chapters, { pageCount: r.pageCount, technical: r.technical });
      rememberPdfPassword(b.id, r.password);
      shelf.add(b, file);
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
function removeBook(id: string) {
  closePdf(id);
  shelf.remove(id);
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
    for (const [i, f] of files.entries()) chapters.push({ title: `第 ${i + 1} 页`, paras: await readPageText(await imageFileData(f), instruction) });
    shelf.add(newBook(`拍的书页 ${new Date().toLocaleDateString()}`, 'photo', chapters));
  } catch (err) {
    showToast(errorText(err));
  } finally {
    busy.value = '';
  }
}

// —— 两种看法 ——
const isPdf = computed(() => book.value?.format === 'pdf');
const view = computed<BookView>(() => (isPdf.value ? (book.value!.view ?? 'text') : 'text'));
const zoom = ref(1);
function setView(v: BookView) {
  const b = book.value;
  if (!b || b.view === v) return;
  if (v === 'page') b.pos.page = pdfPageAt(b, b.pos.chapter, b.pos.para);
  b.view = v;
  onShown();
}

// —— 重排成文字：一章按字数切成页；还没转成文字的扫描页、公式页单独一页 ——
const chapter = computed(() => book.value?.chapters[book.value.pos.chapter]);
function pagesOf(c: BookChapter): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let size = 0;
  c.paras.forEach((p, i) => {
    const alone = scanPageOf(p) !== null || (i > 0 && scanPageOf(c.paras[i - 1]!) !== null);
    if (!out.length || alone || size + p.length > PAGE_CHARS) {
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

// —— 原版页面：按 PDF 的页翻 ——
/** 这一段在 PDF 的第几页 */
function pdfPageAt(b: Book, ci: number, para: number): number {
  const ps = b.chapters[ci]?.pages;
  return ps?.[Math.min(para, ps.length - 1)] ?? 1;
}
const pageCount = computed(() => book.value?.pageCount ?? Math.max(1, ...(book.value?.chapters.flatMap((c) => c.pages ?? []) ?? [1])));
const viewPage = computed(() => (book.value ? (book.value.pos.page ?? pdfPageAt(book.value, book.value.pos.chapter, book.value.pos.para)) : 1));
/** 第 n 页在哪一章：起始页不晚于它的最后一章 */
function chapterOfPage(b: Book, n: number): number {
  let ci = 0;
  b.chapters.forEach((c, i) => {
    if ((c.pages?.[0] ?? Infinity) <= n) ci = i;
  });
  return ci;
}
/** 这一章里在第 n 页上的段落 [from, to)；没有自己的段落（被并进上一页）时是空的 */
function parasOnPage(c: BookChapter, n: number): { from: number; to: number } {
  const ps = c.pages ?? [];
  let from = ps.findIndex((p) => p >= n);
  if (from < 0) from = ps.length;
  let to = from;
  while (to < ps.length && ps[to] === n) to += 1;
  return { from, to };
}
function setPdfPage(n: number) {
  const b = book.value;
  if (!b) return;
  const p = Math.min(Math.max(1, n), pageCount.value);
  const ci = chapterOfPage(b, p);
  const c = b.chapters[ci]!;
  const idx = (c.pages ?? []).findIndex((x) => x >= p);
  b.pos = { chapter: ci, para: idx < 0 ? Math.max(0, c.paras.length - 1) : idx, page: p };
  b.updatedAt = Date.now();
  onShown();
}

/** 现在屏幕上的段落 [from, to)（这一章里） */
const shown = computed(() => {
  const c = chapter.value;
  if (!c) return { from: 0, to: 0 };
  if (view.value === 'page') return parasOnPage(c, viewPage.value);
  return page.value ?? { from: 0, to: 0 };
});
const progress = computed(() => {
  const b = book.value;
  if (!b) return 0;
  if (view.value === 'page') return Math.min(100, Math.round((viewPage.value / pageCount.value) * 100));
  const total = b.chapters.reduce((n, c) => n + c.paras.length, 0) || 1;
  const before = b.chapters.slice(0, b.pos.chapter).reduce((n, c) => n + c.paras.length, 0) + (page.value?.to ?? 0);
  return Math.min(100, Math.round((before / total) * 100));
});
const sessionNotes = ref(0);
const lastQuote = ref('');
const endedChapters = new Set<string>();

function open(b: Book) {
  book.value = b;
  pending.clear();
  requested.clear();
  endedChapters.clear();
  herLine.value = '';
  sessionNotes.value = 0;
  zoom.value = 1;
  // 没选过看法：宽屏上的专业书（扫描页、公式页多）看原版，其余看文字
  if (b.format === 'pdf' && !b.view) b.view = b.technical && window.innerWidth >= 700 ? 'page' : 'text';
  onShown();
}
function closeBook() {
  stopAloud();
  book.value = null;
}
function setPos(ci: number, para: number) {
  const b = book.value!;
  b.pos = { chapter: ci, para, ...(b.format === 'pdf' ? { page: pdfPageAt(b, ci, para) } : {}) };
  b.updatedAt = Date.now();
}
function goPage(i: number) {
  const b = book.value;
  if (!b || !pages.value[i]) return;
  setPos(b.pos.chapter, pages.value[i]!.from);
  onShown();
}
function nextPage() {
  const b = book.value;
  if (!b) return;
  const before = b.pos.chapter;
  if (view.value === 'page') {
    if (viewPage.value >= pageCount.value) {
      void chapterEnd(b.chapters[before]!.title);
      return showToast('读完了这本书');
    }
    setPdfPage(viewPage.value + 1);
    if (b.pos.chapter !== before) void chapterEnd(b.chapters[before]!.title);
    return;
  }
  if (pageIndex.value < pages.value.length - 1) return goPage(pageIndex.value + 1);
  // 一章读完了：她聊两句，再翻到下一章
  void chapterEnd(chapter.value!.title);
  if (b.pos.chapter < b.chapters.length - 1) {
    setPos(b.pos.chapter + 1, 0);
    onShown();
  } else showToast('读完了这本书');
}
function prevPage() {
  const b = book.value;
  if (!b) return;
  if (view.value === 'page') return setPdfPage(viewPage.value - 1);
  if (pageIndex.value > 0) return goPage(pageIndex.value - 1);
  if (b.pos.chapter > 0) {
    const ci = b.pos.chapter - 1;
    setPos(ci, pagesOf(b.chapters[ci]!).at(-1)?.from ?? 0);
    onShown();
  }
}
const tocOpen = ref(false);
function goChapter(i: number) {
  const b = book.value;
  if (!b) return;
  tocOpen.value = false;
  if (view.value === 'page') return setPdfPage(b.chapters[i]?.pages?.[0] ?? 1);
  setPos(i, 0);
  onShown();
}

/** 翻到一页：显示这页上她已经写好的批注，识图和她都往后多读两页 */
function onShown() {
  showPending();
  prefetchPages();
  void requestNotes();
}

// —— 扫描页、公式页：识图提前读，读好之前这一页原样显示 ——
/** 识图正在读的页、读失败的页（页码 → 原因） */
const reading = reactive(new Set<number>());
const readFailed = reactive(new Map<number, string>());
let ocrChain: Promise<void> = Promise.resolve();
let left = false;
onBeforeUnmount(() => {
  left = true;
  stopAloud();
});

/** 第 n 页的占位在哪：[章, 段] */
function placeholderOf(b: Book, n: number): [number, number] | null {
  for (const [ci, c] of b.chapters.entries()) {
    const pi = c.paras.findIndex((p) => scanPageOf(p) === n);
    if (pi >= 0) return [ci, pi];
  }
  return null;
}

/** 交给识图读第 n 页（一页一页排队读）；manual 是你点的"转成文字"或"重新读" */
function transcribe(n: number, manual = false) {
  const b = book.value;
  if (!b || b.format !== 'pdf' || reading.has(n) || (!manual && readFailed.has(n))) return;
  readFailed.delete(n);
  reading.add(n);
  ocrChain = ocrChain.then(async () => {
    try {
      // 换了一本书、离开了：排着队的不读了
      if (left || book.value !== b || !placeholderOf(b, n)) return;
      const paras = await readPageText(await pdfPageImage(b.id, n), ocrInstruction());
      const at = placeholderOf(b, n);
      if (!at) return;
      replacePara(b, at[0], at[1], paras.length ? paras : [`（第 ${n} 页没有读出正文）`], n);
      if (book.value === b) void requestNotes();
    } catch (err) {
      readFailed.set(n, errorText(err));
    } finally {
      reading.delete(n);
    }
  });
}

/** 现在这页和后面两页里还没转成文字的页，识图接通时提前读 */
function prefetchPages() {
  const b = book.value;
  const r = aheadRange();
  if (!b || !r || b.format !== 'pdf' || !visionLive.value) return;
  const c = b.chapters[r.ci]!;
  for (let i = r.from; i < r.to; i += 1) {
    const n = scanPageOf(c.paras[i]!);
    if (n !== null) transcribe(n);
  }
}

/**
 * 一段换成好几段（识图读完一页）：后面段落的编号都往后挪，批注、读到哪、还没显示的批注跟着挪。
 * 记下这次挪动，挪动前就发出去的批注请求回来时按它换算编号
 */
const shifts: { book: string; ci: number; at: number; delta: number }[] = [];
function replacePara(b: Book, ci: number, pi: number, paras: string[], pageNo: number) {
  const c = b.chapters[ci];
  if (!c) return;
  c.paras.splice(pi, 1, ...paras);
  c.pages?.splice(pi, 1, ...paras.map(() => pageNo));
  b.updatedAt = Date.now();
  const delta = paras.length - 1;
  if (delta) {
    shifts.push({ book: b.id, ci, at: pi, delta });
    b.notes = (b.notes ?? []).map((x) => (x.chapter === ci && x.para > pi ? { ...x, para: x.para + delta } : x));
    if (b.pos.chapter === ci && b.pos.para > pi) b.pos.para += delta;
    if (book.value === b) {
      const moved = (k: string) => {
        const [c2, p2] = k.split(':').map(Number) as [number, number];
        return c2 === ci && p2 > pi ? key(c2, p2 + delta) : k;
      };
      const pend = [...pending].map(([k, v]) => [moved(k), v] as const);
      pending.clear();
      for (const [k, v] of pend) pending.set(k, v);
      const req = [...requested].map(moved);
      requested.clear();
      for (const k of req) requested.add(k);
    }
  }
  // 读出来的这几段还没交给她（编号已经按挪过的算）
  if (book.value === b) for (let k = 0; k < paras.length; k += 1) requested.delete(key(ci, pi + k));
}
/** 请求发出后（shifts 的第 since 条起）段落挪过：把当时的编号换成现在的 */
function shifted(bookId: string, ci: number, para: number, since: number): number {
  let p = para;
  for (const s of shifts.slice(since)) if (s.book === bookId && s.ci === ci && p > s.at) p += s.delta;
  return p;
}

// —— 她的页边批注：提前写好接下来几页，翻到才显示 ——
const pending = new Map<string, { quote: string; note: string; expr?: string }>();
const requested = new Set<string>();
const key = (ci: number, p: number) => `${ci}:${p}`;
const cueOf = (c: number, p: number, quote?: string) => `${book.value?.chapters[c]?.title ?? ''} 第 ${p + 1} 段${quote ? `「${clipRich(quote, 24)}」` : ''}`;

/** 从现在这页开始往后大约三页的段落 [from, to)：文字看法按字数分的页，原版看法按 PDF 的页 */
function aheadRange(): { ci: number; from: number; to: number } | null {
  const b = book.value;
  const c = chapter.value;
  if (!b || !c) return null;
  if (view.value === 'page') {
    const from = shown.value.from;
    let to = from;
    while (to < c.paras.length && (c.pages?.[to] ?? 0) <= viewPage.value + 2) to += 1;
    return { ci: b.pos.chapter, from, to };
  }
  const ps = pages.value;
  const i = pageIndex.value;
  return { ci: b.pos.chapter, from: ps[i]?.from ?? 0, to: ps[Math.min(i + 2, ps.length - 1)]?.to ?? 0 };
}

/** 这一屏上已经写好的批注：显示出来，存进聊天 */
function showPending() {
  const b = book.value;
  if (!b) return;
  const ci = b.pos.chapter;
  for (let p = shown.value.from; p < shown.value.to; p += 1) {
    const n = pending.get(key(ci, p));
    if (!n) continue;
    pending.delete(key(ci, p));
    b.notes = [...(b.notes ?? []), { chapter: ci, para: p, who: 'her', quote: n.quote, text: n.note, at: Date.now() }];
    chat.push(chatId.value, 'assistant', [{ type: 'text', text: n.note }], { meta: { scene: 'read', cue: cueOf(ci, p, n.quote), agent: 'companion' }, expression: n.expr ?? null });
    if (n.expr) chars.setExpression(her.value.id, n.expr);
    herLine.value = n.note;
  }
}

async function requestNotes() {
  const b = book.value;
  const r = aheadRange();
  if (!b || !r || notConnected.value) return;
  const c = b.chapters[r.ci]!;
  const live = visionLive.value;
  const paras: { i: number; text: string }[] = [];
  for (let i = r.from; i < r.to; i += 1) {
    if (requested.has(key(r.ci, i))) continue;
    const t = c.paras[i]!;
    const n = scanPageOf(t);
    if (n === null) paras.push({ i, text: t });
    // 识图会读这一页，读完再给她；识图没接通时，有公式的页先给她文字层读出来的文字
    else if (!live && scanFallbackOf(t)) paras.push({ i, text: `（第 ${n} 页从 PDF 文字层读出来的，公式可能是乱的）${scanFallbackOf(t)}` });
  }
  if (!paras.length) return;
  for (const x of paras) requested.add(key(r.ci, x.i));
  const since = shifts.length;
  const valid = new Set(paras.map((x) => x.i));
  const res = await chat.sceneJson(
    chatId.value,
    {
      name: 'read-batch',
      input: [
        `书名：《${b.title}》`,
        `这一章：${c.title}`,
        `前情提要：${b.summary || '（刚开始读）'}`,
        `话量：${TALK[talk.value].label}（${TALK[talk.value].hint}）`,
        '接下来几页的段落（编号 正文）：',
        ...paras.map((x) => `#${x.i} ${clipRich(x.text, 800)}`),
      ].join('\n'),
    },
    (v) => {
      const o = v as { notes?: unknown; summary?: unknown } | null;
      if (!o || !Array.isArray(o.notes)) return null;
      const notes = o.notes
        .map((x) => x as { para?: unknown; quote?: unknown; note?: unknown; expr?: unknown })
        .filter((x) => valid.has(Number(x.para)) && typeof x.note === 'string' && x.note.trim())
        .map((x) => ({
          para: Number(x.para),
          // 公式不切开；JSON 里没转义的 \frac \theta 改回来
          quote: typeof x.quote === 'string' ? clipRich(repairJsonLatex(x.quote.trim()), 120, '') : '',
          note: clipRich(repairJsonLatex(String(x.note).trim()), 160, ''),
          ...(typeof x.expr === 'string' && isExpression(x.expr) ? { expr: x.expr } : {}),
        }));
      return { notes, summary: typeof o.summary === 'string' ? clipRich(repairJsonLatex(o.summary.trim()), 600, '') : '' };
    },
  );
  if (!res.ok) {
    if (res.notConnected) notConnected.value = res.reason;
    else for (const x of paras) requested.delete(key(r.ci, shifted(b.id, r.ci, x.i, since)));
    return;
  }
  if (res.value.summary && book.value === b) b.summary = res.value.summary;
  for (const n of res.value.notes) pending.set(key(r.ci, shifted(b.id, r.ci, n.para, since)), { quote: n.quote, note: n.note, expr: n.expr });
  // 刚好就在这一页：马上显示
  if (book.value === b && b.pos.chapter === r.ci) showPending();
}

// —— 你划一句、写一句 ——
const noteOpen = ref(false);
const notePara = ref(0);
const noteQuote = ref('');
const noteText = ref('');
function openNote(p: number, el?: EventTarget | null) {
  // 原版看法里这一页没有自己的段落（被并进上一页）时，挂在这一章最后一段
  notePara.value = Math.max(0, Math.min(p, (chapter.value?.paras.length ?? 1) - 1));
  // 选到公式时换回公式原文，这样划的这句能在原文里找到
  noteQuote.value = el instanceof Element ? selectionSource(el) : '';
  noteText.value = '';
  noteOpen.value = true;
}
async function saveNote() {
  const b = book.value;
  const c = chapter.value;
  const text = noteText.value.trim();
  if (!b || !c || !text) return;
  noteOpen.value = false;
  const ci = b.pos.chapter;
  const p = notePara.value;
  const quote = noteQuote.value.trim();
  b.notes = [...(b.notes ?? []), { chapter: ci, para: p, who: 'you', quote, text, at: Date.now() }];
  sessionNotes.value += 1;
  if (quote) lastQuote.value = quote;
  const para = c.paras[p] ?? '';
  const body = scanPageOf(para) !== null ? `（第 ${scanPageOf(para)} 页，还没转成文字）${scanFallbackOf(para)}` : para;
  const r = await chat.sceneReply(chatId.value, {
    task: 'read-note',
    input: [`书名：《${b.title}》`, `${c.title} 第 ${p + 1} 段：${clipRich(body, 800)}`, quote ? `${userName.value}划了：「${quote}」` : ''].filter(Boolean).join('\n'),
    userText: text,
    cue: cueOf(ci, p, quote),
  });
  if (!r.ok) return fail(r);
  b.notes = [...(b.notes ?? []), { chapter: ci, para: p, who: 'her', text: r.message.text, at: Date.now() }];
  herLine.value = r.message.text;
}

async function chapterEnd(title: string) {
  const b = book.value;
  if (!b || endedChapters.has(title)) return;
  endedChapters.add(title);
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
  const where = view.value === 'page' ? `第 ${viewPage.value} 页，` : '';
  const r = await chat.sceneReply(chatId.value, {
    task: 'read-chat',
    input: [`书名：《${b.title}》`, `读到：${chapter.value?.title ?? ''}（${where}全书 ${progress.value}%）`, `前情提要：${b.summary || '（刚开始读）'}`].join('\n'),
    userText: text,
    cue: cueOf(b.pos.chapter, b.pos.para),
  });
  if (r.ok) herLine.value = r.message.text;
  else fail(r);
}

// —— 读给你听：用她的声音一段一段念（公式念成中文），念到哪段亮哪段，念到下一页自动翻 ——
const speakingPara = ref<number | null>(null);
let stopSpeaking = false;
async function readAloud() {
  const b = book.value;
  const c = chapter.value;
  if (!b || !c) return;
  stopSpeaking = false;
  const ci = b.pos.chapter;
  for (let p = shown.value.from; p < c.paras.length && !stopSpeaking; p += 1) {
    if (book.value !== b || b.pos.chapter !== ci) break;
    const text = c.paras[p]!;
    if (scanPageOf(text) !== null || /^\s*\[图/.test(text)) continue;
    speakingPara.value = p;
    if (view.value === 'page') {
      const n = c.pages?.[p];
      if (n && n !== viewPage.value) setPdfPage(n);
    } else if (page.value && p >= page.value.to) goPage(pageIndex.value + 1);
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

// —— 显示 ——
const shownParas = computed(() => Array.from({ length: Math.max(0, shown.value.to - shown.value.from) }, (_, k) => shown.value.from + k));
/** 文字看法这一屏的段落；scan 是还没转成文字的扫描页、公式页的页码 */
const items = computed(() =>
  shownParas.value.map((p) => {
    const text = chapter.value?.paras[p] ?? '';
    const scan = scanPageOf(text);
    return { p, text, scan, math: scan !== null && !!scanFallbackOf(text) };
  }),
);
const notesOn = (p: number) => (book.value?.notes ?? []).filter((n) => n.chapter === book.value!.pos.chapter && n.para === p);
/** 原版看法：这一页上的批注 */
const pageNotes = computed(() => shownParas.value.flatMap((p) => notesOn(p)));
/** 原版看法：这一页还没转成文字（扫描页、公式页） */
const pageScan = computed(() => (view.value === 'page' && book.value ? (placeholderOf(book.value, viewPage.value) ? viewPage.value : null) : null));
/** 段落的样式：标题、列表、只有公式的段落不缩进；紧跟在公式后面的接着上文，也不缩进 */
function paraClass(p: number) {
  const c = chapter.value!;
  const kind = paraKind(c.paras[p]!);
  const afterMath = p > 0 && paraKind(c.paras[p - 1]!) === 'math';
  return [`k-${kind}`, { speaking: speakingPara.value === p, 'para-indent': kind === 'p' && !afterMath }];
}
function scanStatus(n: number): string {
  if (reading.has(n)) return `${her.value.name}在读这一页…`;
  if (readFailed.has(n)) return '没读出来';
  if (!visionLive.value) return '识图还没接通，先看原样';
  return '还没转成文字';
}
function cycleZoom() {
  zoom.value = ZOOMS[(ZOOMS.indexOf(zoom.value) + 1) % ZOOMS.length]!;
}
function onPageCount(n: number) {
  if (book.value && book.value.pageCount !== n) book.value.pageCount = n;
}
</script>

<template>
  <SceneShell scene-id="read" :hide-figure="!!book" :fill="!!book" pose="sit" :line="herLine" :typing="replying && !herLine" :title="book ? `《${book.title}》` : undefined" :layout="{ left: 78, bottom: 56, height: 30 }">
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
          <span class="block truncate text-[12px] text-ink-3">{{ b.format.toUpperCase() }}<template v-if="b.pageCount"> · {{ b.pageCount }} 页</template> · {{ b.chapters.length }} 章 · 读到{{ b.chapters[b.pos.chapter]?.title }}</span>
        </span>
        <button type="button" class="text-ink-3 px-1" aria-label="从书架上拿走" @click.stop="removeBook(b.id)"><span class="i-lucide-trash-2" /></button>
      </button>
      <div v-if="!shelf.books.length" class="text-[12.5px] text-ink-3 mt-2">书架还是空的。书只存在这台设备上，发给模型的只有当前这几页。</div>
      <div class="grid grid-cols-3 gap-2 mt-3">
        <label class="add press"><span class="i-lucide-file-up text-[20px]" />EPUB / TXT / PDF<input type="file" class="hidden" accept=".epub,.txt,.pdf" @change="onFile" /></label>
        <button type="button" class="add press" @click="pasteOpen = true"><span class="i-lucide-clipboard-paste text-[20px]" />粘贴文章</button>
        <label class="add press"><span class="i-lucide-camera text-[20px]" />拍书页<input type="file" class="hidden" accept="image/*" capture="environment" multiple @change="onPhotos" /></label>
      </div>
      <div class="text-[12px] text-ink-3 mt-3 leading-relaxed">教材、讲义、论文也能读：扫描页和有公式的页交给"识图"读成文字，公式照书上的样子显示。</div>
    </template>

    <!-- 读 -->
    <template v-else>
      <div class="flex items-center gap-2 text-[12.5px] text-ink-3 flex-none">
        <button type="button" class="truncate text-accent-ink min-w-0" @click="tocOpen = true">{{ chapter?.title }}</button>
        <span class="shrink-0 num">
          <template v-if="view === 'page'">第 {{ viewPage }} / {{ pageCount }} 页</template>
          <template v-else>{{ pageIndex + 1 }} / {{ pages.length }}</template>
          · {{ progress }}%
        </span>
        <span class="flex-1" />
        <span v-if="isPdf" class="views" role="tablist" aria-label="怎么看">
          <button type="button" role="tab" :aria-selected="view === 'page'" :class="{ on: view === 'page' }" @click="setView('page')">原版</button>
          <button type="button" role="tab" :aria-selected="view === 'text'" :class="{ on: view === 'text' }" @click="setView('text')">文字</button>
        </span>
        <button v-if="view === 'page'" type="button" class="shrink-0 num" aria-label="缩放" @click="cycleZoom">{{ zoom }}×</button>
        <button type="button" class="shrink-0" @click="closeBook">书架</button>
      </div>

      <!-- 原版页面 -->
      <div v-if="view === 'page'" class="paper">
        <PdfPage :book-id="book.id" :page="viewPage" :zoom="zoom" @pages="onPageCount" />
        <div v-if="pageScan !== null" class="scan-bar">
          <van-loading v-if="reading.has(pageScan)" size="13px" />
          <span class="flex-1 min-w-0">{{ scanStatus(pageScan) }}</span>
          <button v-if="!visionLive" type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=vision')">接通识图</button>
          <button v-else-if="!reading.has(pageScan)" type="button" class="text-accent-ink shrink-0" @click="transcribe(pageScan, true)">{{ readFailed.has(pageScan) ? '重新读' : '转成文字' }}</button>
        </div>
        <div v-if="pageScan !== null && readFailed.get(pageScan)" class="scan-err">{{ readFailed.get(pageScan) }}</div>
        <div v-for="(n, k) in pageNotes" :key="k" class="margin" :class="n.who">
          <span v-if="n.quote" class="q">「<RichText :text="n.quote" />」</span>{{ n.who === 'her' ? `${her.name}：` : '我：' }}<RichText :text="n.text" />
        </div>
      </div>

      <!-- 重排成文字 -->
      <div v-else class="paper">
        <template v-for="{ p, text, scan, math } in items" :key="p">
          <!-- 还没转成文字的扫描页、公式页：先原样显示 -->
          <div v-if="scan !== null" class="scan">
            <div class="scan-bar">
              <van-loading v-if="reading.has(scan)" size="13px" />
              <span class="flex-1 min-w-0">第 {{ scan }} 页{{ math ? '有公式' : '是扫描页' }} · {{ scanStatus(scan) }}</span>
              <button v-if="!visionLive" type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=vision')">接通识图</button>
              <button v-else-if="!reading.has(scan)" type="button" class="text-accent-ink shrink-0" @click="transcribe(scan, true)">{{ readFailed.has(scan) ? '重新读' : '转成文字' }}</button>
            </div>
            <div v-if="readFailed.get(scan)" class="scan-err">{{ readFailed.get(scan) }}</div>
            <PdfPage :book-id="book.id" :page="scan" />
          </div>
          <div v-else class="para" :class="paraClass(p)" @click="openNote(p, $event.currentTarget)"><RichText :text="text" block /></div>
          <div v-for="(n, k) in notesOn(p)" :key="k" class="margin" :class="n.who">
            <span v-if="n.quote" class="q">「<RichText :text="n.quote" />」</span>{{ n.who === 'her' ? `${her.name}：` : '我：' }}<RichText :text="n.text" />
          </div>
        </template>
      </div>

      <div class="flex gap-2 mt-2 btns flex-none">
        <van-button size="small" round block @click="prevPage">上一页</van-button>
        <van-button v-if="speakingPara === null" size="small" round block @click="readAloud">读给我听</van-button>
        <van-button v-else size="small" round block @click="stopAloud">停</van-button>
        <van-button v-if="view === 'page'" size="small" round block @click="openNote(shown.from)">写批注</van-button>
        <van-button size="small" type="primary" round block @click="nextPage">下一页</van-button>
      </div>
      <div class="flex gap-2 mt-2 flex-none">
        <input v-model="chatText" class="field" :placeholder="view === 'page' ? `和${her.pronoun}聊聊这一页` : `和${her.pronoun}聊聊这本书（点一段可以写批注）`" aria-label="聊这本书" @keydown.enter="sendChat" />
        <van-button size="small" round :disabled="replying" @click="sendChat">发送</van-button>
      </div>
      <div class="flex items-center gap-2 mt-2 flex-none">
        <span class="text-[12.5px] text-ink-3 shrink-0">批注话量</span>
        <button v-for="(v, k) in TALK" :key="k" type="button" class="chip" :class="{ on: talk === k }" @click="talk = k">{{ v.label }}</button>
        <span class="flex-1" />
        <van-button size="small" round @click="finish">今天读到这里</van-button>
      </div>
    </template>

    <van-popup v-model:show="pasteOpen" position="bottom" round :style="{ height: '70%' }">
      <div class="p-4 flex flex-col gap-2 h-full">
        <div class="text-[15px] font-600">粘贴一篇文章</div>
        <input v-model="pasteTitle" class="field !flex-none" placeholder="标题" aria-label="标题" />
        <textarea v-model="pasteText" class="area flex-1" placeholder="把正文粘贴到这里（公式可以用 $…$ 和 $$…$$ 写）" aria-label="正文" />
        <van-button type="primary" round block @click="addPasted">放上书架</van-button>
      </div>
    </van-popup>
    <van-popup v-model:show="noteOpen" position="bottom" round>
      <div class="p-4">
        <div class="text-[15px] font-600 mb-2">写一句批注</div>
        <input v-model="noteQuote" class="field w-full" placeholder="划哪一句（可以先在正文里选中再点）" aria-label="划的句子" />
        <div v-if="noteQuote && noteQuote.includes('$')" class="quote-preview">「<RichText :text="noteQuote" />」</div>
        <textarea v-model="noteText" class="area mt-2" rows="3" placeholder="你的想法（公式可以写成 $…$）" aria-label="批注" />
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
  flex: none;
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
/* 翻开书时面板占满（SceneShell 的 fill），书页占剩下的高度 */
.paper {
  flex: 1 1 0;
  min-height: 200px;
  overflow-y: auto;
  margin-top: 8px;
  padding: 4px 2px;
}
.para {
  margin: 0 0 10px;
  font-size: 15.5px;
  line-height: 1.8;
}
.para.para-indent {
  text-indent: 2em;
}
.para.k-h1,
.para.k-h2,
.para.k-h3 {
  margin-top: 14px;
}
.para.k-math {
  margin: 0 0 6px;
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
.paper > .margin:first-of-type {
  margin-top: 10px;
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
  margin-bottom: 12px;
}
.scan-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 12.5px;
  color: var(--ink-2);
}
.scan-err {
  margin: -4px 0 8px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--warn, #c4553a);
  word-break: break-all;
}
.views {
  display: inline-flex;
  flex: none;
  padding: 2px;
  border-radius: 99px;
  background: var(--panel);
}
.views button {
  height: 22px;
  padding: 0 9px;
  border-radius: 99px;
  font-size: 12px;
  color: var(--ink-2);
}
.views button.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
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
.quote-preview {
  margin-top: 6px;
  font-size: 13px;
  color: var(--ink-2);
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
