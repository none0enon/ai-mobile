/**
 * 消息里的"HTML 界面"（``` 代码块里的整页 HTML：播放器、状态栏这类"前端卡"），在沙盒 iframe 里运行。
 * - 沙盒只给 allow-scripts 等，不给 allow-same-origin：页面是一个不透明的来源，读不到 App 的本机数据（聊天、API Key），
 *   也碰不到 App 的页面；能联网（受 CORS 限制）、能放声音；
 * - 先在页面最前面放一小段桥接脚本：
 *   - 报告内容的高度，小窗跟着变高；
 *   - 酒馆助手（JS-Slash-Runner）里前端卡常用的几个接口：getCurrentMessageId / getLastMessageId（这是第几楼、最后一楼，从 0 数）、
 *     eventOn / eventOnce / eventEmit / eventRemoveListener（几个界面互相通知，例如一个播放器开始放了，别的停下）；
 * - 100vh 这类按视口高度写的尺寸换成固定像素：小窗的高度跟着内容变，按小窗算 vh 会越撑越高。
 */

export interface FrameState {
  /** 这一条是第几条消息（从 0 数，同 ST 的 message id） */
  messageId: number;
  /** 最后一条是第几条 */
  lastMessageId: number;
  theme: 'dark' | 'light';
}

/** 小窗最高多少像素（防止写错的页面无限撑高） */
export const FRAME_MAX_HEIGHT = 3000;

const BRIDGE = `(function () {
  var ID = __ID__;
  var state = __STATE__;
  var listeners = {};
  function send(m) { m.__aiMobile = ID; try { parent.postMessage(m, '*'); } catch (e) { console.warn('[HTML 界面] 发不出去', e); } }
  function off(name, fn) { listeners[name] = (listeners[name] || []).filter(function (l) { return l.fn !== fn; }); }
  function on(name, fn, once) {
    (listeners[name] = listeners[name] || []).push({ fn: fn, once: !!once });
    return { stop: function () { off(name, fn); } };
  }
  window.getCurrentMessageId = function () { return state.messageId; };
  window.getLastMessageId = function () { return state.lastMessageId; };
  window.eventOn = function (name, fn) { return on(String(name), fn, false); };
  window.eventOnce = function (name, fn) { return on(String(name), fn, true); };
  window.eventRemoveListener = function (name, fn) { off(String(name), fn); };
  window.eventClearEvent = function (name) { delete listeners[String(name)]; };
  window.eventEmit = function (name) {
    send({ type: 'event', name: String(name), args: Array.prototype.slice.call(arguments, 1) });
    return Promise.resolve();
  };
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== parent || !d || d.__aiMobileHost !== ID) return;
    if (d.type === 'state') {
      state.messageId = d.messageId;
      state.lastMessageId = d.lastMessageId;
      var meta = document.querySelector('meta[name="color-scheme"]');
      if (meta && d.theme) meta.setAttribute('content', d.theme);
    } else if (d.type === 'event') {
      (listeners[d.name] || []).slice().forEach(function (l) {
        if (l.once) off(d.name, l.fn);
        try { l.fn.apply(null, d.args || []); } catch (err) { console.error(err); }
      });
    }
  });
  var last = -1, timer = 0;
  function measure() {
    var de = document.documentElement, b = document.body;
    var h = de ? de.getBoundingClientRect().height : 0;
    if (b) h = Math.max(h, b.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(b).marginBottom) || 0), b.scrollHeight);
    return Math.ceil(h);
  }
  function report() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = 0;
      var h = measure();
      if (Math.abs(h - last) >= 1) { last = h; send({ type: 'height', height: h }); }
    }, 30);
  }
  var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null;
  if (ro) ro.observe(document.documentElement);
  document.addEventListener('DOMContentLoaded', function () { if (ro && document.body) ro.observe(document.body); report(); });
  window.addEventListener('load', report);
  report();
})();`;

/** 样式里按视口高度写的尺寸（100vh、50dvh……）换成固定像素 */
function fixViewportUnits(code: string, viewportHeight: number): string {
  const fix = (css: string) => css.replace(/(\d+(?:\.\d+)?)[dsl]?vh\b/g, (_, n: string) => `${Math.round((Number(n) * viewportHeight) / 100)}px`);
  return code
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open: string, css: string, close: string) => open + fix(css) + close)
    .replace(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (_, attr: string, q: string, css: string) => attr + q + fix(css) + q);
}

/** 放进 <head> 的最前面；没有 <head> 时放在 <html> 后面，再没有就放在 doctype 后面 */
function injectHead(doc: string, inject: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(doc);
  if (head) return doc.slice(0, head.index + head[0].length) + inject + doc.slice(head.index + head[0].length);
  const html = /<html(\s[^>]*)?>/i.exec(doc);
  if (html) return `${doc.slice(0, html.index + html[0].length)}<head>${inject}</head>${doc.slice(html.index + html[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(doc);
  if (doctype) return doctype[0] + inject + doc.slice(doctype[0].length);
  return `<!doctype html>${inject}${doc}`;
}

/** 小窗里的整页：桥接脚本 + 基础样式（透明背景、不出竖滚动条）+ 原来的页面 */
export function buildFrameDoc(code: string, frameId: string, state: FrameState, viewportHeight: number): string {
  const bridge = BRIDGE.replace('__ID__', () => JSON.stringify(frameId)).replace('__STATE__', () => JSON.stringify(state));
  const head =
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="${state.theme}">` +
    `<base target="_blank"><style>html{overflow-y:hidden}html,body{margin:0;padding:0;background:transparent}</style><script>${bridge}</script>`;
  return injectHead(fixViewportUnits(code, viewportHeight), head);
}

/** 正在显示的小窗：一个界面 eventEmit 的事件转给所有小窗（包括它自己，同酒馆助手） */
const frames = new Map<string, () => Window | null>();

export function registerFrame(id: string, win: () => Window | null): () => void {
  frames.set(id, win);
  return () => frames.delete(id);
}

export function broadcastFrameEvent(name: string, args: unknown[]) {
  for (const [id, win] of frames) {
    try {
      win()?.postMessage({ __aiMobileHost: id, type: 'event', name, args }, '*');
    } catch {
      // 参数传不过去（函数之类）：这个事件不转
    }
  }
}

/** 告诉小窗它现在是第几条、最后一条是第几条、日夜（不重新加载页面） */
export function postFrameState(id: string, win: Window | null | undefined, state: FrameState) {
  win?.postMessage({ __aiMobileHost: id, type: 'state', ...state }, '*');
}
