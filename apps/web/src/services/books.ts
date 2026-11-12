import { listZip, readZipEntry } from '@app/ai';
import { useAiStore } from '@/stores/ai';
import { useBookStore } from '@/stores/books';
import { compressImage } from '@/utils/image';
import { decodeTextFile } from '@/utils/text';

/**
 * 一起看书的书（设计文档 §9.10）：EPUB、TXT、PDF、粘贴的文章、拍下的纸质书页，读成"章 → 段"。
 * 书只存在本机；发给模型的只有当前这几页。
 * 专业书（教材、讲义、论文）的公式一律写成 LaTeX（$…$、$$…$$），显示时交给 KaTeX（utils/math.ts）：
 * 扫描页和有公式的页交给"识图"读成 Markdown + LaTeX；EPUB 里的 MathML 取它带的 TeX 原文。
 */
export interface BookChapter {
  title: string;
  paras: string[];
  /** PDF：每段在第几页（从 1 开始） */
  pages?: number[];
}

export type BookFormat = 'txt' | 'epub' | 'pdf' | 'paste' | 'photo';

export interface BookNote {
  chapter: number;
  para: number;
  who: 'you' | 'her';
  /** 划线的那一句 */
  quote?: string;
  text: string;
  at: number;
}

/** PDF 的两种看法：原版页面（教材、论文、扫描版）、重排成文字（小说） */
export type BookView = 'page' | 'text';

export interface Book {
  id: string;
  title: string;
  format: BookFormat;
  chapters: BookChapter[];
  createdAt: number;
  updatedAt: number;
  /** 你读到哪；看原版页面时 page 是 PDF 的第几页 */
  pos: { chapter: number; para: number; page?: number };
  /** 前情提要：读到这里为止发生了什么 */
  summary?: string;
  notes?: BookNote[];
  /** PDF：一共几页 */
  pageCount?: number;
  /** PDF：扫描页、公式页占三成以上（教材、讲义、论文、扫描书） */
  technical?: boolean;
  /** PDF：现在用哪种看法；没选过时宽屏上的专业书看原版，其余看文字 */
  view?: BookView;
}

/**
 * PDF 里要交给识图读的页：没有文字层（扫描版）、读出来是乱码，或者有公式（文字层读出来的公式是乱的）。
 * 段落里放这个占位：\u0000scan:页码；有公式的页后面再接 \u0000 和文字层读出来的文字（识图没接通时先给她看这个）。
 * 界面上这一页先按原样显示，识图读完换成读出来的段落
 */
export const SCAN_MARK = '\u0000scan:';
export function scanPageOf(para: string): number | null {
  if (!para.startsWith(SCAN_MARK)) return null;
  const n = parseInt(para.slice(SCAN_MARK.length), 10);
  return Number.isFinite(n) ? n : null;
}
/** 占位里存的文字层文字（有公式的页才有） */
export function scanFallbackOf(para: string): string {
  const i = para.indexOf('\u0000', 1);
  return i > 0 ? para.slice(i + 1) : '';
}
export function scanMark(page: number, fallback = ''): string {
  return `${SCAN_MARK}${page}${fallback ? `\u0000${fallback}` : ''}`;
}

const CHAPTER_HEAD = /^\s*(第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*[章回节卷集部篇]|序章|序言|楔子|引子|尾声|后记|番外)/;
const CJK = /[　-鿿＀-￯]/;

/**
 * 一行一段，但跨行的公式（$$ … $$、\[ … \]、\begin{…} … \end{…}）和表格并成一段，免得公式被拆开
 */
export function groupLines(rawLines: string[]): string[] {
  const out: string[] = [];
  let block: string[] = [];
  let waitFor = '';
  for (const raw of rawLines) {
    const line = raw.trim();
    if (waitFor) {
      block.push(line);
      if (line.includes(waitFor)) {
        out.push(block.join('\n').trim());
        block = [];
        waitFor = '';
      }
      continue;
    }
    if (!line) continue;
    if (line.startsWith('|') && out.at(-1)?.startsWith('|')) {
      out[out.length - 1] += `\n${line}`;
      continue;
    }
    waitFor = unclosedMath(line);
    if (waitFor) block = [line];
    else out.push(line);
  }
  // 没等到结束记号：按行放回去
  out.push(...block.filter(Boolean));
  return out;
}

/** 这一行开了公式没关上：返回要等的结束记号 */
function unclosedMath(line: string): string {
  if ((line.match(/(?<!\\)\$\$/g) ?? []).length % 2 === 1) return '$$';
  if (line.lastIndexOf('\\[') > line.lastIndexOf('\\]')) return '\\]';
  let open = '';
  let depth = 0;
  for (const m of line.matchAll(/\\(begin|end)\{([a-zA-Z*]+)\}/g)) {
    if (!open && m[1] === 'begin') open = m[2]!;
    if (m[2] === open) depth += m[1] === 'begin' ? 1 : -1;
  }
  return open && depth > 0 ? `\\end{${open}}` : '';
}

/** 识图读出来的一页（Markdown + LaTeX）→ 段。模型把结果包在代码块里时先拆掉 */
export function splitBookParas(text: string): string[] {
  const body = text
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/, '$1');
  return groupLines(body.split('\n'));
}

/** 一大段纯文字 → 章：认"第 X 章 / 回 / 节……"；认不出时每 3000 字左右分一段 */
export function chaptersFromText(text: string): BookChapter[] {
  const lines = groupLines(text.replace(/\r\n?/g, '\n').split('\n'));
  const chapters: BookChapter[] = [];
  for (const line of lines) {
    if (CHAPTER_HEAD.test(line) && line.length <= 40) chapters.push({ title: line, paras: [] });
    else {
      if (!chapters.length) chapters.push({ title: '开头', paras: [] });
      chapters.at(-1)!.paras.push(line);
    }
  }
  const real = chapters.filter((c) => c.paras.length);
  if (real.length > 1 || (real.length === 1 && real[0]!.title !== '开头')) return real;
  // 没有章节标题：按字数切
  const out: BookChapter[] = [];
  let size = 0;
  for (const p of lines) {
    if (!out.length || size > 3000) {
      out.push({ title: `第 ${out.length + 1} 部分`, paras: [] });
      size = 0;
    }
    out.at(-1)!.paras.push(p);
    size += p.length;
  }
  return out;
}

export async function parseTxt(file: Blob): Promise<BookChapter[]> {
  return chaptersFromText(decodeTextFile(new Uint8Array(await file.arrayBuffer())));
}

// —— EPUB：zip 里的 OPF 列出按顺序读的 XHTML ——
export async function parseEpub(file: Blob): Promise<{ title: string; chapters: BookChapter[] }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = listZip(bytes);
  const dec = new TextDecoder();
  const read = async (path: string) => {
    const clean = decodeURIComponent(path).replace(/^\/+/, '');
    const e = entries.find((x) => x.name === clean || decodeURIComponent(x.name) === clean);
    return e ? dec.decode(await readZipEntry(bytes, e)) : null;
  };
  const xml = (s: string, type: DOMParserSupportedType = 'application/xml') => new DOMParser().parseFromString(s, type);
  const container = await read('META-INF/container.xml');
  const opfPath = container ? (xml(container).querySelector('rootfile')?.getAttribute('full-path') ?? '') : '';
  const opfText = opfPath ? await read(opfPath) : null;
  if (!opfText) throw new Error('这个 EPUB 读不出目录（找不到 OPF）');
  const opf = xml(opfText);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const title = opf.getElementsByTagName('dc:title')[0]?.textContent?.trim() || opf.querySelector('title')?.textContent?.trim() || '';
  const manifest = new Map<string, string>();
  for (const item of [...opf.getElementsByTagName('item')]) manifest.set(item.getAttribute('id') ?? '', item.getAttribute('href') ?? '');
  const chapters: BookChapter[] = [];
  for (const ref of [...opf.getElementsByTagName('itemref')]) {
    const href = manifest.get(ref.getAttribute('idref') ?? '');
    if (!href) continue;
    const html = await read(base + href.split('#')[0]);
    if (!html) continue;
    let doc = xml(html, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) doc = xml(html, 'text/html');
    keepEpubMath(doc);
    const paras = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote')].map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const body = paras.length ? paras : (doc.body?.textContent ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!body.length) continue;
    const head = doc.querySelector('h1,h2,h3')?.textContent?.trim() || doc.querySelector('title')?.textContent?.trim() || `第 ${chapters.length + 1} 节`;
    chapters.push({ title: head.slice(0, 40), paras: body });
  }
  if (!chapters.length) throw new Error('这个 EPUB 里没有读出正文');
  return { title, chapters };
}

/**
 * EPUB 里的公式：MathML 带着 TeX 原文（<annotation encoding="application/x-tex">，或 alttext）时换成 $…$；
 * 公式图片（pandoc 的 img.math）用 alt 里的 TeX。都没有的照旧取文字
 */
function keepEpubMath(doc: Document) {
  for (const m of [...doc.getElementsByTagNameNS('*', 'math')]) {
    const tex =
      [...m.getElementsByTagNameNS('*', 'annotation')].find((a) => /tex/i.test(a.getAttribute('encoding') ?? ''))?.textContent?.trim() ||
      m.getAttribute('alttext')?.trim();
    if (!tex) continue;
    const block = m.getAttribute('display') === 'block' || m.getAttribute('mode') === 'display';
    m.replaceWith(doc.createTextNode(block ? ` $$${tex}$$ ` : ` $${tex}$ `));
  }
  for (const img of [...doc.getElementsByTagName('img')]) {
    const alt = img.getAttribute('alt')?.trim();
    const cls = img.getAttribute('class') ?? '';
    if (!alt || !/\bmath\b/.test(cls)) continue;
    img.replaceWith(doc.createTextNode(/\bdisplay\b/.test(cls) ? ` $$${alt}$$ ` : ` $${alt}$ `));
  }
}

// —— PDF：pdf.js 用到时才加载 ——
type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    return pdfjs;
  })();
  return pdfjsPromise;
}

interface Line {
  text: string;
  x: number;
  right: number;
  y: number;
  h: number;
}

/** pdf.js 读出来的文字块 */
interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}
const itemHeight = (it: TextItem) => Math.abs(it.height) || Math.hypot(it.transform[2] ?? 0, it.transform[3] ?? 0) || 10;

/** 一页的文字块 → 行（同一高度的合成一行），双栏按栏排 */
function pageLines(items: TextItem[], pageWidth: number): Line[] {
  const raw = items
    .filter((it) => it.str.trim())
    .map((it) => ({ str: it.str, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0, w: it.width, h: itemHeight(it) }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: (Line & { parts: typeof raw })[] = [];
  for (const it of raw) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < it.h * 0.5 && (it.x > l.right - it.h || it.x + it.w < l.x + it.h));
    if (line) {
      line.parts.push(it);
      line.x = Math.min(line.x, it.x);
      line.right = Math.max(line.right, it.x + it.w);
    } else lines.push({ text: '', x: it.x, right: it.x + it.w, y: it.y, h: it.h, parts: [it] });
  }
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    l.text = l.parts.reduce((s, p, i) => {
      const prev = l.parts[i - 1];
      const gap = prev ? p.x - (prev.x + prev.w) : 0;
      const needSpace = prev && gap > p.h * 0.25 && !CJK.test(s.slice(-1)) && !CJK.test(p.str[0] ?? '');
      return s + (needSpace ? ' ' : '') + p.str;
    }, '').trim();
  }
  // 双栏：两边各有不少整行都只在半边，就先排左栏再排右栏
  const mid = pageWidth / 2;
  const left = lines.filter((l) => l.right < mid + 10);
  const right = lines.filter((l) => l.x > mid - 10);
  const sorted = (xs: Line[]) => xs.sort((a, b) => b.y - a.y);
  if (left.length >= lines.length * 0.3 && right.length >= lines.length * 0.3) {
    const full = lines.filter((l) => !left.includes(l) && !right.includes(l));
    return [...sorted([...full, ...left]), ...sorted(right)];
  }
  return sorted(lines);
}

/** 行 → 段：行距明显变大、或上一行以句号结束且这一行缩进时分段；英文行尾连字符接回去 */
function linesToParas(lines: Line[]): string[] {
  if (!lines.length) return [];
  const gaps = lines.slice(1).map((l, i) => lines[i]!.y - l.y).filter((g) => g > 0).sort((a, b) => a - b);
  const heights = lines.map((l) => l.h).sort((a, b) => a - b);
  const lineH = heights[Math.floor(heights.length / 2)] ?? 12;
  // 正常行距取最小的那个（不小于一行字的高度）：段落之间的大空隙不会把它带偏，行少的页也一样
  const typical = Math.max(gaps[0] ?? lineH * 1.4, lineH * 0.9);
  const minX = Math.min(...lines.map((l) => l.x));
  const paras: string[] = [];
  let cur = '';
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    const gap = prev ? prev.y - l.y : 0;
    const indent = l.x - minX > l.h * 1.2;
    const breakHere = !prev || gap > typical * 1.6 || gap < 0 || (/[。！？.!?」』”)]$/.test(cur) && indent);
    if (breakHere) {
      if (cur) paras.push(cur);
      cur = l.text;
    } else if (/[a-z]-$/i.test(cur)) cur = cur.slice(0, -1) + l.text;
    else cur += CJK.test(cur.slice(-1)) || CJK.test(l.text[0] ?? '') ? l.text : ` ${l.text}`;
  });
  if (cur) paras.push(cur);
  return paras;
}

/** 读出来像乱码（替换符、私用区字符太多）就当没有文字层 */
function looksGarbled(s: string): boolean {
  if (!s) return true;
  const bad = [...s].filter((c) => c === '�' || (c >= '' && c <= '')).length;
  return bad / s.length > 0.3;
}

/** 数学符号：希腊字母、箭头、运算符、数学字母（𝑥 𝑦） */
const MATH_SYMBOL = /[Α-Ωα-ω←-⇿∀-⋿⟀-⟯⦀-⫿′″]|[\u{1d400}-\u{1d7ff}]/gu;

/**
 * 这一页有公式：文字层读出来的公式是乱的（上下标拆成一行一行、分数没了分数线、积分号丢了），交给识图重新读。
 * 看数学符号的个数，加上比正文小一圈的短小文字块（上标、下标）
 */
function looksMathy(items: TextItem[], text: string): boolean {
  const symbols = (text.match(MATH_SYMBOL) ?? []).length;
  const sized = items.filter((it) => it.str.trim()).map((it) => ({ s: it.str.trim(), h: itemHeight(it) }));
  const heights = sized.map((x) => x.h).sort((a, b) => a - b);
  const body = heights[Math.floor(heights.length / 2)] ?? 10;
  const scripts = sized.filter((x) => x.s.length <= 3 && /[\p{L}\p{N}]/u.test(x.s) && x.h < body * 0.8).length;
  const score = symbols + scripts / 2;
  return score >= 8 || (score >= 4 && score / Math.max(1, text.length) > 0.01);
}

export interface ParsedPdf {
  title: string;
  chapters: BookChapter[];
  pageCount: number;
  /** 扫描页、公式页占三成以上（教材、讲义、论文、扫描书） */
  technical: boolean;
  /** 打开时用的密码（这次打开 App 期间记住，翻页、识图时不用再问） */
  password?: string;
}

export async function parsePdf(file: Blob, askPassword: () => Promise<string | null>): Promise<ParsedPdf> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let password: string | undefined;
  task.onPassword = async (update: (pw: string) => void) => {
    const pw = await askPassword();
    if (pw === null) void task.destroy();
    else update((password = pw));
  };
  const pdf = await task.promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = ((meta?.info as { Title?: string } | undefined)?.Title ?? '').trim();
  // 每页的行
  const pageLinesList: { page: number; lines: Line[]; scanned: boolean; math: boolean }[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items as TextItem[];
    const lines = pageLines(items, vp.width);
    const text = lines.map((l) => l.text).join('');
    const scanned = text.replace(/\s/g, '').length < 20 || looksGarbled(text);
    pageLinesList.push({ page: n, lines, scanned, math: !scanned && looksMathy(items, text) });
  }
  // 页眉页脚：同样的首两行 / 末两行（去掉数字）在很多页重复出现就去掉；单独的页码也去掉。在分段之前去掉，免得粘进正文
  const norm = (s: string) => s.replace(/\d+/g, '#').trim();
  const edges = (ls: Line[]) => [...ls.slice(0, 2), ...ls.slice(-2)].map((l) => norm(l.text));
  const count = new Map<string, number>();
  for (const p of pageLinesList) for (const e of new Set(edges(p.lines))) if (e) count.set(e, (count.get(e) ?? 0) + 1);
  const repeated = new Set([...count].filter(([, c]) => c >= 2 && c >= pageLinesList.length * 0.4).map(([k]) => k));
  const pageParas = pageLinesList.map((p) => {
    const kept = p.lines.filter((l, i) => !(i < 2 || i >= p.lines.length - 2) || (!repeated.has(norm(l.text)) && !/^[\s\-–—·第页]*\d+[\s\-–—·页]*$/.test(l.text)));
    return { page: p.page, scanned: p.scanned, math: p.math, paras: p.scanned ? [] : linesToParas(kept) };
  });
  // 目录 → 章的起始页；没有目录就每 10 页一章
  const starts: { page: number; title: string }[] = [];
  try {
    for (const item of (await pdf.getOutline()) ?? []) {
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      const ref = dest?.[0];
      if (ref && typeof ref === 'object') starts.push({ page: (await pdf.getPageIndex(ref as Parameters<typeof pdf.getPageIndex>[0])) + 1, title: item.title });
    }
  } catch {
    // 目录读不出来就按页分
  }
  starts.sort((a, b) => a.page - b.page);
  if (starts.length < 2) {
    starts.length = 0;
    for (let p = 1; p <= pdf.numPages; p += 10) starts.push({ page: p, title: `第 ${p}–${Math.min(pdf.numPages, p + 9)} 页` });
  } else if (starts[0]!.page > 1) starts.unshift({ page: 1, title: '开头' });
  const chapters: BookChapter[] = starts.map((s) => ({ title: s.title.slice(0, 40), paras: [], pages: [] }));
  const chapterOf = (page: number) => {
    let i = 0;
    starts.forEach((s, k) => {
      if (s.page <= page) i = k;
    });
    return i;
  };
  for (const p of pageParas) {
    const ch = chapters[chapterOf(p.page)]!;
    // 扫描页、公式页：整页一个占位，先按原样显示，交给识图读（公式页留着文字层的文字，识图没接通时先给她看）
    if (p.scanned || p.math) {
      ch.paras.push(scanMark(p.page, p.math ? p.paras.join('\n') : ''));
      ch.pages!.push(p.page);
      continue;
    }
    p.paras.forEach((para, i) => {
      // 上一页最后一段没说完（没有句末标点）：接上这一页的第一段
      const last = ch.paras.length - 1;
      if (i === 0 && last >= 0 && scanPageOf(ch.paras[last]!) === null && !/[。！？.!?」』”)：:]$/.test(ch.paras[last]!)) {
        ch.paras[last] += CJK.test(para[0] ?? '') ? para : ` ${para}`;
        return;
      }
      ch.paras.push(para);
      ch.pages!.push(p.page);
    });
  }
  const pageCount = pdf.numPages;
  const special = pageParas.filter((p) => p.scanned || p.math).length;
  void pdf.destroy();
  return { title, chapters: chapters.filter((c) => c.paras.length), pageCount, technical: special >= pageCount * 0.3, password };
}

// —— 书架上的 PDF：原版页面和识图都从本机存的原文件画 ——
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

/** 打开过的 PDF（最近两本）：翻页时不用每次重新解析整本 */
const openDocs = new Map<string, Promise<PdfDoc>>();
/** 这次打开 App 期间用过的密码 */
const passwords = new Map<string, string>();

export function rememberPdfPassword(bookId: string, password: string | undefined) {
  if (password) passwords.set(bookId, password);
}

export function pdfOf(bookId: string): Promise<PdfDoc> {
  let doc = openDocs.get(bookId);
  if (doc) return doc;
  doc = (async () => {
    const file = await useBookStore().fileOf(bookId);
    if (!file) throw new Error('找不到这本 PDF 的原文件，重新导入一次试试');
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password: passwords.get(bookId) });
    task.onPassword = (update: (pw: string) => void, reason: number) => {
      const pw = window.prompt(reason === 2 ? '密码不对，再输一次：' : '这个 PDF 有密码，请输入：');
      if (pw === null) void task.destroy();
      else update(pw);
      if (pw) passwords.set(bookId, pw);
    };
    return task.promise;
  })();
  doc.catch(() => openDocs.delete(bookId));
  openDocs.set(bookId, doc);
  for (const [id, old] of openDocs) {
    if (openDocs.size <= 2) break;
    openDocs.delete(id);
    void old.then((d) => d.destroy()).catch(() => undefined);
  }
  return doc;
}

/** 从书架上拿走时关掉 */
export function closePdf(bookId: string) {
  const doc = openDocs.get(bookId);
  openDocs.delete(bookId);
  void doc?.then((d) => d.destroy()).catch(() => undefined);
}

/** PDF 的一页画成 JPEG 交给识图读：长边约 2000 像素，公式的上下标也看得清 */
export async function pdfPageImage(bookId: string, pageNo: number): Promise<{ mime: string; data: string }> {
  const pdf = await pdfOf(bookId);
  const page = await pdf.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(3, 2000 / Math.max(base.width, base.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.85);
  // iOS 上 canvas 占的内存要手动放掉
  canvas.width = 0;
  canvas.height = 0;
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

/** 照片 → 压到长边 2000 像素（拍下的纸质书页；手机原图太大，有的接口不收） */
export async function imageFileData(file: Blob): Promise<{ mime: string; data: string }> {
  const url = await compressImage(file, { max: 2000, quality: 0.85 });
  return { mime: url.slice(5, url.indexOf(';')), data: url.slice(url.indexOf(',') + 1) };
}

/**
 * 交给"识图"读出一页书（PDF 的一页或拍的照片）。读法（说明文字）来自"一起看书"功能预设里的"识图读书页"一块，不写在代码里。
 * 读出来是 Markdown，公式是 LaTeX；按段切开（跨行的公式、表格不切开）。一页公式多，输出上限给到 4096
 */
export async function readPageText(image: { mime: string; data: string }, instruction: string, signal?: AbortSignal): Promise<string[]> {
  const ai = useAiStore();
  const st = ai.status('vision');
  if (!st.live) throw new Error(`识图还没接通：${st.reason}`);
  const r = await ai.system.chat('vision', { messages: [{ role: 'user', content: [{ type: 'image', mime: image.mime, data: image.data }, { type: 'text', text: instruction }] }], maxTokens: 4096 }, { signal });
  return splitBookParas(r.text);
}
