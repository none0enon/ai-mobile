import { listZip, readZipEntry } from '@app/ai';
import { useAiStore } from '@/stores/ai';
import { decodeTextFile } from '@/utils/text';

/**
 * 一起看书的书（设计文档 §9.10）：EPUB、TXT、PDF、粘贴的文章、拍下的纸质书页，读成"章 → 段"。
 * 书只存在本机；发给模型的只有当前这几页。
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

export interface Book {
  id: string;
  title: string;
  format: BookFormat;
  chapters: BookChapter[];
  createdAt: number;
  updatedAt: number;
  /** 你读到哪 */
  pos: { chapter: number; para: number };
  /** 前情提要：读到这里为止发生了什么 */
  summary?: string;
  notes?: BookNote[];
}

/** PDF 里没有文字层（扫描版）或读出来是乱码的页：段落里放这个占位，界面上显示"交给识图读这一页" */
export const SCAN_MARK = '\u0000scan:';
export const scanPageOf = (para: string): number | null => (para.startsWith(SCAN_MARK) ? Number(para.slice(SCAN_MARK.length)) : null);

const CHAPTER_HEAD = /^\s*(第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*[章回节卷集部篇]|序章|序言|楔子|引子|尾声|后记|番外)/;
const CJK = /[　-鿿＀-￯]/;

/** 一大段纯文字 → 章：认"第 X 章 / 回 / 节……"；认不出时每 3000 字左右分一段 */
export function chaptersFromText(text: string): BookChapter[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
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
    const paras = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote')].map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const body = paras.length ? paras : (doc.body?.textContent ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!body.length) continue;
    const head = doc.querySelector('h1,h2,h3')?.textContent?.trim() || doc.querySelector('title')?.textContent?.trim() || `第 ${chapters.length + 1} 节`;
    chapters.push({ title: head.slice(0, 40), paras: body });
  }
  if (!chapters.length) throw new Error('这个 EPUB 里没有读出正文');
  return { title, chapters };
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

/** 一页的文字块 → 行（同一高度的合成一行），双栏按栏排 */
function pageLines(items: { str: string; transform: number[]; width: number; height: number }[], pageWidth: number): Line[] {
  const raw = items
    .filter((it) => it.str.trim())
    .map((it) => ({ str: it.str, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0, w: it.width, h: Math.abs(it.height) || Math.hypot(it.transform[2] ?? 0, it.transform[3] ?? 0) || 10 }))
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

export async function parsePdf(file: Blob, askPassword: () => Promise<string | null>): Promise<{ title: string; chapters: BookChapter[] }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  task.onPassword = async (update: (pw: string) => void) => {
    const pw = await askPassword();
    if (pw === null) void task.destroy();
    else update(pw);
  };
  const pdf = await task.promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title = ((meta?.info as { Title?: string } | undefined)?.Title ?? '').trim();
  // 每页的行
  const pageLinesList: { page: number; lines: Line[]; scanned: boolean }[] = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = pageLines(tc.items as { str: string; transform: number[]; width: number; height: number }[], vp.width);
    const text = lines.map((l) => l.text).join('');
    pageLinesList.push({ page: n, lines, scanned: text.replace(/\s/g, '').length < 20 || looksGarbled(text) });
  }
  // 页眉页脚：同样的首两行 / 末两行（去掉数字）在很多页重复出现就去掉；单独的页码也去掉。在分段之前去掉，免得粘进正文
  const norm = (s: string) => s.replace(/\d+/g, '#').trim();
  const edges = (ls: Line[]) => [...ls.slice(0, 2), ...ls.slice(-2)].map((l) => norm(l.text));
  const count = new Map<string, number>();
  for (const p of pageLinesList) for (const e of new Set(edges(p.lines))) if (e) count.set(e, (count.get(e) ?? 0) + 1);
  const repeated = new Set([...count].filter(([, c]) => c >= 2 && c >= pageLinesList.length * 0.4).map(([k]) => k));
  const pageParas = pageLinesList.map((p) => {
    const kept = p.lines.filter((l, i) => !(i < 2 || i >= p.lines.length - 2) || (!repeated.has(norm(l.text)) && !/^[\s\-–—·第页]*\d+[\s\-–—·页]*$/.test(l.text)));
    return { page: p.page, scanned: p.scanned, paras: p.scanned ? [] : linesToParas(kept) };
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
    if (p.scanned) {
      ch.paras.push(`${SCAN_MARK}${p.page}`);
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
  return { title, chapters: chapters.filter((c) => c.paras.length) };
}

/** PDF 的一页画成 JPEG（交给识图读扫描页） */
export async function renderPdfPage(file: Blob, pageNo: number): Promise<{ mime: string; data: string }> {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale: 1.6 });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.82);
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

/** 照片 → base64（拍下的纸质书页） */
export async function imageFileData(file: Blob): Promise<{ mime: string; data: string }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime: file.type || 'image/jpeg', data: btoa(bin) };
}

/**
 * 交给"识图"功能读出图片里的文字。读法（说明文字）来自"一起看书"功能预设里的"识图读书页"一块，不写在代码里
 */
export async function readImageText(image: { mime: string; data: string }, instruction: string): Promise<string[]> {
  const ai = useAiStore();
  const st = ai.status('vision');
  if (!st.live) throw new Error(`识图还没接通：${st.reason}`);
  const r = await ai.system.chat('vision', { messages: [{ role: 'user', content: [{ type: 'image', mime: image.mime, data: image.data }, { type: 'text', text: instruction }] }] });
  return r.text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}
