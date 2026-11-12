import { splitMath, unescapeDollar, type MathSeg } from '@app/shared';
import { shallowRef } from 'vue';

/**
 * 公式显示（同 math-reader 的讲义：KaTeX，$…$ 行内、$$…$$ 单独成行）和一点 Markdown（标题、列表、加粗、表格）。
 * 一起看书的专业书正文、她的批注、聊天气泡里有公式时都走这里。
 */

type Katex = typeof import('katex').default;

/** KaTeX 用到公式时才加载（脚本、样式、字体都打包在本站里，装成 App 以后断网也能显示） */
export const katexLib = shallowRef<Katex | null>(null);
let loading: Promise<Katex | null> | null = null;

export function loadKatex(): Promise<Katex | null> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([m]) => (katexLib.value = m.default))
    .catch((e: unknown) => {
      console.warn('KaTeX 加载失败，公式先显示原文', e);
      loading = null;
      return null;
    });
  return loading;
}

const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITY[c] ?? c);
}

/** 渲染过的公式（同一条批注、同一页会反复渲染） */
const rendered = new Map<string, string>();

function mathHtml(seg: Extract<MathSeg, { kind: 'math' }>, k: Katex | null): string {
  const src = escapeHtml(seg.raw);
  // data-tex 存原文：选中公式写批注时换回原文，才能在书里找到这一句
  if (!k) return `<span class="rich-math rich-src" data-tex="${src}">${src}</span>`;
  const key = `${seg.display ? 'D' : 'I'}${seg.tex}`;
  let html = rendered.get(key);
  if (html === undefined) {
    try {
      html = k.renderToString(seg.tex, { displayMode: seg.display, throwOnError: false, strict: false, output: 'htmlAndMathml' });
    } catch {
      html = src;
    }
    rendered.set(key, html);
    if (rendered.size > 1000) rendered.delete(rendered.keys().next().value as string);
  }
  return `<span class="${seg.display ? 'rich-math rich-display' : 'rich-math'}" data-tex="${src}">${html}</span>`;
}

/** 行内的 Markdown（文字已转义、公式已换成占位符）：加粗、代码；聊天里的（动作）*动作* 淡一点，正文里的 *斜体* */
function inlineMarkdown(h: string, actions: boolean): string {
  let out = h.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+?)`/g, '<code>$1</code>');
  if (actions) out = out.replace(/(（[^）]*）|\([^)]*\)|\*[^*]+\*)/g, '<span class="action">$1</span>');
  else out = out.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<i>$2</i>');
  // 公式和紧挨着的标点不分开换行（"。"不会落到下一行开头，"（"不会留在上一行末尾）
  return out.replace(/([（「『“‘([]*)(\u0001\d+\u0002)([。，、；：？！）」』”’.,;:?!)\]]*)/g, (m, open: string, math: string, close: string) =>
    open || close ? `<span class="rich-nb">${open}${math}${close}</span>` : m,
  );
}

export type ParaKind = 'h1' | 'h2' | 'h3' | 'li' | 'quote' | 'table' | 'math' | 'p';

/** 一段是什么：标题、列表项、引用、表格、只有公式，还是普通段落（普通段落首行缩进） */
export function paraKind(text: string): ParaKind {
  const t = text.trimStart();
  const h = /^(#{1,6})\s/.exec(t);
  if (h) return h[1]!.length === 1 ? 'h1' : h[1]!.length === 2 ? 'h2' : 'h3';
  if (/^([-*+•·]|\d{1,3}[.)、])\s/.test(t)) return 'li';
  if (/^>\s?/.test(t)) return 'quote';
  if (t.startsWith('|') && t.includes('\n')) return 'table';
  const segs = splitMath(text);
  if (segs.some((s) => s.kind === 'math') && segs.every((s) => (s.kind === 'math' ? s.display : !s.text.trim()))) return 'math';
  return 'p';
}

/**
 * 文字 → HTML：先把公式换成占位符（免得 Markdown 处理弄坏公式，表格的竖线也不会切开 |z| 这样的公式），
 * 处理完再换回渲染好的公式。KaTeX 还没加载好时公式先显示原文。
 * block：一整段书的正文（认标题、列表、引用、表格）；actions：聊天气泡（括号、星号里的动作淡一点）
 */
export function richHtml(text: string, k: Katex | null, opts: { block?: boolean; actions?: boolean } = {}): string {
  const maths: string[] = [];
  let masked = '';
  for (const s of splitMath(text)) {
    if (s.kind === 'text') masked += escapeHtml(unescapeDollar(s.text));
    else {
      masked += `\u0001${maths.length}\u0002`;
      maths.push(mathHtml(s, k));
    }
  }
  const inline = (h: string) => inlineMarkdown(h, !!opts.actions).replace(/\n/g, '<br>').replace(/\u0001(\d+)\u0002/g, (_, i: string) => maths[Number(i)] ?? '');
  if (!opts.block) return inline(masked);

  const t = masked.trim();
  const lines = t.split('\n');
  if (lines.length >= 2 && lines.every((l) => l.trim().startsWith('|'))) {
    const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells(lines[1]!).every((c) => /^:?-{2,}:?$/.test(c))) {
      const head = cells(lines[0]!);
      const rows = lines.slice(2).map(cells);
      return `<table class="rich-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_, j) => `<td>${inline(r[j] ?? '')}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
    }
  }
  const h = /^(#{1,6})\s+([\s\S]*)$/.exec(t);
  if (h) return `<span class="rich-h rich-h${Math.min(3, h[1]!.length)}">${inline(h[2]!)}</span>`;
  const li = /^([-*+•·]|\d{1,3}[.)、])\s+([\s\S]*)$/.exec(t);
  if (li) return `<span class="rich-li"><span class="rich-mk">${/\d/.test(li[1]!) ? li[1]!.replace(/[)、]$/, '.') : '•'}</span><span class="rich-lt">${inline(li[2]!)}</span></span>`;
  const q = /^&gt;\s?([\s\S]*)$/.exec(t);
  if (q) return `<span class="rich-q">${inline(q[1]!)}</span>`;
  return inline(t);
}

/**
 * 选中的文字（选区在 root 里时）。选到公式时换回公式的原文（$…$），这样能在书的原文里找到这一句；
 * 只选了公式的一部分时扩到整个公式
 */
export function selectionSource(root: Element): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const range = sel.getRangeAt(0).cloneRange();
  if (!root.contains(range.commonAncestorContainer)) return '';
  const mathOf = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement)?.closest('.rich-math') ?? null;
  const a = mathOf(range.startContainer);
  if (a) range.setStartBefore(a);
  const b = mathOf(range.endContainer);
  if (b) range.setEndAfter(b);
  const frag = range.cloneContents();
  for (const el of [...frag.querySelectorAll('.rich-math')]) el.replaceWith(document.createTextNode(el.getAttribute('data-tex') ?? ''));
  return (frag.textContent ?? '').trim();
}
