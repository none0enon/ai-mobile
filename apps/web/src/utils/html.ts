import { escapeHtml } from './math';

/**
 * 消息中的 HTML（消息设置开启 HTML 渲染时）。
 * - ``` 代码块：行首的 ``` / ~~~ 才算（同 Markdown）。代码块里是整页 HTML 的（有 html> <head> <body>，同酒馆助手的判断）
 *   叫"HTML 界面"，在沙盒小窗里运行（utils/frames.ts）；
 * - 其余文字里的 HTML 标签按白名单重新建一遍节点：只留排版用的标签和属性（<details> <b> <span style> <table> <img>……），
 *   脚本、事件属性、javascript: 链接、<style>、<iframe>、表单控件一律去掉；不认识的标签去掉标签、留下里面的字（同 ST 的 DOMPurify）。
 *   从头建节点、不把原来的 HTML 字符串塞进页面，所以没有"解析两遍结果不一样"这类漏洞。
 */

export type FenceSegment = { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string; closed: boolean };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** 分出 ``` 代码块；没写完的代码块（流式时、或者忘了收尾）一直算到最后 */
export function splitFences(text: string): FenceSegment[] {
  const out: FenceSegment[] = [];
  let buf: string[] = [];
  let fence: { close: RegExp; lang: string; lines: string[] } | null = null;
  const flush = () => {
    if (buf.length) out.push({ kind: 'text', text: buf.join('\n') });
    buf = [];
  };
  for (const line of text.split('\n')) {
    if (fence) {
      if (fence.close.test(line)) {
        out.push({ kind: 'code', lang: fence.lang, code: fence.lines.join('\n'), closed: true });
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    const m = FENCE_OPEN.exec(line);
    // 反引号的代码块，后面的语言名里不能再有反引号（同 CommonMark）
    if (m && !(m[1]!.startsWith('`') && m[2]!.includes('`'))) {
      flush();
      const ch = m[1]!.startsWith('`') ? '`' : '~';
      fence = { close: new RegExp(`^ {0,3}${ch}{${m[1]!.length},}\\s*$`), lang: m[2]!.trim(), lines: [] };
      continue;
    }
    buf.push(line);
  }
  if (fence) out.push({ kind: 'code', lang: fence.lang, code: fence.lines.join('\n'), closed: false });
  flush();
  return out;
}

/** 代码块里是不是一整页 HTML（播放器、状态栏这类"前端卡"） */
export function isFrontendCode(code: string): boolean {
  return /html>|<head[\s>]|<body[\s>]/i.test(code);
}

/** 块级标签：前后紧挨着的换行不再多出一行空行 */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'colgroup', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const ALLOWED = new Set([
  ...BLOCK,
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'col', 'data', 'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'mark', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);
/** 连同里面的内容一起去掉（其余不认识的只去掉标签，例如 <button> 留下按钮上的字） */
const DROP = new Set([
  'applet', 'area', 'audio', 'base', 'canvas', 'datalist', 'embed', 'frame', 'frameset', 'head', 'iframe', 'input', 'link', 'map',
  'math', 'meta', 'noembed', 'noscript', 'object', 'optgroup', 'option', 'param', 'picture', 'plaintext', 'portal', 'script', 'select', 'slot',
  'source', 'style', 'svg', 'template', 'textarea', 'title', 'track', 'video', 'xmp',
]);
const GLOBAL_ATTRS = ['title', 'lang', 'dir', 'align', 'style'];
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  font: ['color', 'size', 'face'],
  td: ['colspan', 'rowspan', 'valign', 'width'],
  th: ['colspan', 'rowspan', 'valign', 'width'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  table: ['width', 'border', 'cellpadding', 'cellspacing'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  details: ['open'],
  time: ['datetime'],
  data: ['value'],
};

/** 链接只认 http(s)、mailto、页内锚点；图片只认 http(s) 和位图的 data: */
function safeUrl(tag: string, value: string): string | null {
  const v = value.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (tag === 'a') return /^(https?:|mailto:|#)/i.test(v) ? value.trim() : null;
  return /^(https?:|data:image\/(png|jpe?g|gif|webp|avif|bmp);)/i.test(v) ? value.trim() : null;
}

/** 行内样式：去掉能盖住整个页面的 position: fixed / sticky、非 http(s) 图片的 url()、老 IE 的 expression 之类 */
export function cleanStyle(style: string): string {
  return style
    .split(';')
    .map((d) => d.trim())
    .filter((d) => {
      const i = d.indexOf(':');
      if (i <= 0) return false;
      const prop = d.slice(0, i).trim().toLowerCase();
      const value = d.slice(i + 1).trim().toLowerCase().replace(/\\/g, '');
      if (!/^-?[a-z][a-z0-9-]*$/.test(prop) || /behavior|binding/.test(prop)) return false;
      if (/expression|javascript:|vbscript:|@import|binding/.test(value)) return false;
      if (prop === 'position' && !/^(static|relative|absolute)(\s*!important)?$/.test(value)) return false;
      const urls = [...value.matchAll(/url\s*\(\s*['"]?([^'")]*)/g)].map((m) => (m[1] ?? '').trim());
      return urls.every((u) => /^(https?:|data:image\/(png|jpe?g|gif|webp|avif|bmp);)/.test(u));
    })
    .join('; ');
}

function copyAttrs(from: Element, to: HTMLElement) {
  const tag = to.localName;
  const allowed = new Set([...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] ?? [])]);
  for (const { name, value } of [...from.attributes]) {
    const n = name.toLowerCase();
    if (!allowed.has(n)) continue;
    if (n === 'style') {
      const s = cleanStyle(value);
      if (s) to.setAttribute('style', s);
    } else if (n === 'href' || n === 'src') {
      const u = safeUrl(tag, value);
      if (u) to.setAttribute(n, u);
    } else to.setAttribute(n, value);
  }
  if (tag === 'a') {
    to.setAttribute('target', '_blank');
    to.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  if (tag === 'img') {
    to.setAttribute('loading', 'lazy');
    to.setAttribute('referrerpolicy', 'no-referrer');
  }
}

const isElement = (n: Node | undefined): n is Element => !!n && n.nodeType === Node.ELEMENT_NODE;
const breaks = (n: Node | undefined) => isElement(n) && (BLOCK.has(n.localName) || n.localName === 'br');

/** 一段可信的 HTML（已转义的文字、KaTeX 渲染的公式）接到 to 后面 */
function appendTrusted(to: Node, html: string) {
  const t = document.createElement('template');
  t.innerHTML = html;
  to.appendChild(t.content);
}

interface CopyCtx {
  /** 父节点是块级的（或者是最外层） */
  block: boolean;
  /** 在 <pre> 里：字原样 */
  pre: boolean;
  /** 最外层（聊天的正文）：标签之间的换行算换行；标签里面的换行只是排版（同 ST：HTML 块原样，正文换行变 <br>） */
  root: boolean;
}

function copyChildren(from: Node, to: Node, ctx: CopyCtx, renderText: (text: string) => string) {
  const kids = [...from.childNodes];
  kids.forEach((node, i) => {
    if (node.nodeType === Node.TEXT_NODE) {
      let t = node.nodeValue ?? '';
      if (!ctx.pre) {
        const prevBreak = i === 0 ? ctx.block : breaks(kids[i - 1]);
        const nextBreak = i === kids.length - 1 ? ctx.block : breaks(kids[i + 1]);
        if (!t.trim() && t.includes('\n')) {
          // 标签之间只有换行和缩进：挨着块级标签的是排版，去掉；标签里面的当一个空格；正文里的照样换行
          if (prevBreak || nextBreak) return;
          if (!ctx.root) t = ' ';
        } else {
          // 块级标签前后的那个换行只是排版（<details>\n<summary>…），不再多出一行空行
          if (prevBreak) t = t.replace(/^[ \t]*\n/, '');
          if (nextBreak) t = t.replace(/\n[ \t]*$/, '');
        }
      }
      if (t) appendTrusted(to, ctx.pre ? escapeHtml(t) : renderText(t));
      return;
    }
    if (!isElement(node)) return;
    const tag = node.localName;
    if (DROP.has(tag)) return;
    if (!ALLOWED.has(tag)) {
      copyChildren(node, to, ctx, renderText);
      return;
    }
    const out = document.createElement(tag);
    copyAttrs(node, out);
    // 图片地址不能用（javascript:、相对路径……）：整张不要，免得留一个破图
    if (tag === 'img' && !out.hasAttribute('src')) return;
    copyChildren(node, out, { block: BLOCK.has(tag), pre: ctx.pre || tag === 'pre', root: false }, renderText);
    to.appendChild(out);
  });
}

/**
 * 文字里的 HTML → 可以放进页面的节点。renderText 把一段纯文字变成 HTML（转义、动作淡一点、公式），
 * <pre> 里的字原样转义
 */
export function safeHtmlFragment(html: string, renderText: (text: string) => string): DocumentFragment {
  const src = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html').body;
  const frag = document.createDocumentFragment();
  copyChildren(src, frag, { block: true, pre: false, root: true }, renderText);
  return frag;
}

/** 短一点的哈希（给 HTML 界面当 key：内容不变，小窗就不重新加载） */
export function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
