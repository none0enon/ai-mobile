import { nextTick, onBeforeUnmount, reactive, watch, type Ref } from 'vue';

/**
 * 列表拖动排序，手机和电脑都能用：
 * - 手机：长按一行（约 0.35 秒，会轻震一下）就能拖；按住左边的手柄可以直接拖。
 *   没到长按就划动是正常滚动页面，轻点是正常点击；
 * - 电脑：鼠标按住一行（或手柄）拖一下就开始，轻点是正常点击；按住不动也会进入拖动；
 * - 拖到列表看得见的区域的上下边缘会自动滚；拖动中按 Esc 取消；
 * - 键盘：在手柄上按 ↑ ↓ 挪一格。
 *
 * 用法：列表容器绑 list；每一项加 data-sort-item（渲染顺序 = 数组顺序），绑
 * @pointerdown="onPointerDown($event, i)"、@touchstart.passive="onTouchStart($event, i)"、:style="styleFor(i)"；
 * 手柄加 data-sort-handle，不该触发拖动的控件（开关）加 data-sort-ignore。松手后调用 onMove(from, to)，由调用方改数组。
 */
export interface DragSortOptions {
  list: Ref<HTMLElement | null>;
  onMove(from: number, to: number): void;
  /** 列表看得见的区域的上沿（视口坐标），例如吸顶标签栏的下沿；不给就用滚动容器的上沿 */
  visibleTop?: () => number;
  /** 手机长按多久开始拖（毫秒） */
  delay?: number;
}

interface Press {
  kind: 'touch' | 'pointer';
  id: number;
  index: number;
  x: number;
  y: number;
  lastY: number;
  el: HTMLElement;
  handle: boolean;
  timer: number | undefined;
}

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export function useDragSort(opts: DragSortOptions) {
  const delay = opts.delay ?? 350;
  const state = reactive({
    phase: 'idle' as 'idle' | 'drag' | 'drop',
    /** 被拖的那一项原来的位置、现在会落到的位置 */
    from: -1,
    to: -1,
    /** 被拖的那一项跟着手指移动了多少 */
    dy: 0,
    /** 其他项让位时挪动的距离（被拖那一项的高度 + 间距） */
    shift: 0,
    /** 放下：被拖的那一项先停在松手的地方，再滑进新位置 */
    dropIndex: -1,
    dropOffset: 0,
    dropAnimating: false,
  });

  let press: Press | null = null;
  let rects: { top: number; height: number }[] = [];
  let startY = 0;
  let pointerY = 0;
  let scroller: HTMLElement | null = null;
  let startScroll = 0;
  let raf = 0;
  let swallowClick = false;
  let dropTimer: number | undefined;

  function items(): HTMLElement[] {
    const list = opts.list.value;
    return list ? Array.from(list.querySelectorAll<HTMLElement>(':scope > [data-sort-item]')) : [];
  }

  function scrollParent(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll') return p;
    }
    return null;
  }

  // —— 按下：记下是哪一项、按在哪儿；手机等长按，电脑等移动 ——
  function begin(kind: Press['kind'], id: number, index: number, x: number, y: number, el: HTMLElement, target: EventTarget | null) {
    if (state.phase !== 'idle') return;
    // 上一次按压没收到松手（切走了窗口之类）：作废
    if (press) release();
    if (!(target instanceof Element) || target.closest('[data-sort-ignore]')) return;
    const handle = !!target.closest('[data-sort-handle]');
    press = { kind, id, index, x, y, lastY: y, el, handle, timer: undefined };
    press.timer = window.setTimeout(activate, delay);
    if (kind === 'pointer') {
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    }
  }

  function onPointerDown(e: PointerEvent, index: number) {
    // 手指走 touch 事件（能在长按后拦住页面滚动），这里只管鼠标和笔
    if (e.pointerType === 'touch' || e.button !== 0 || !e.isPrimary) return;
    begin('pointer', e.pointerId, index, e.clientX, e.clientY, e.currentTarget as HTMLElement, e.target);
  }

  function onTouchStart(e: TouchEvent, index: number) {
    if (e.touches.length !== 1) {
      // 第二根手指（缩放之类）：不是拖动
      if (press?.kind === 'touch' && state.phase === 'idle') release();
      return;
    }
    const t = e.changedTouches[0];
    if (t) begin('touch', t.identifier, index, t.clientX, t.clientY, e.currentTarget as HTMLElement, e.target);
  }

  /** 手指 / 鼠标动了 */
  function moved(x: number, y: number) {
    if (!press) return;
    press.lastY = y;
    if (state.phase === 'drag') {
      pointerY = y;
      update();
      return;
    }
    const dist = Math.hypot(x - press.x, y - press.y);
    if (press.kind === 'pointer' || press.handle) {
      if (dist > (press.kind === 'pointer' ? 4 : 3)) {
        activate();
        pointerY = y;
        update();
      }
    } else if (dist > 10) {
      // 还没到长按手指就动了：这是在滚动页面
      release();
    }
  }

  function touchOf(list: TouchList, id: number): Touch | undefined {
    return Array.from(list).find((t) => t.identifier === id);
  }

  function onTouchMove(e: TouchEvent) {
    if (!press || press.kind !== 'touch') return;
    const t = touchOf(e.changedTouches, press.id);
    if (!t) return;
    moved(t.clientX, t.clientY);
    // 拖动中：这根手指不再滚动页面
    if (state.phase === 'drag' && e.cancelable) e.preventDefault();
  }

  function onTouchEnd(e: TouchEvent) {
    if (!press || press.kind !== 'touch' || !touchOf(e.changedTouches, press.id)) return;
    if (state.phase === 'drag') {
      // 不让松手变成一次"点击"（不然会打开这一项）
      if (e.cancelable) e.preventDefault();
      drop();
    } else release();
  }

  function onTouchCancel(e: TouchEvent) {
    if (!press || press.kind !== 'touch' || !touchOf(e.changedTouches, press.id)) return;
    if (state.phase === 'drag') cancel();
    else release();
  }

  function onPointerMove(e: PointerEvent) {
    if (press?.kind === 'pointer' && e.pointerId === press.id) moved(e.clientX, e.clientY);
  }

  function onPointerUp(e: PointerEvent) {
    if (press?.kind !== 'pointer' || e.pointerId !== press.id) return;
    if (state.phase === 'drag') drop();
    else release();
  }

  function onPointerCancel(e: PointerEvent) {
    if (press?.kind !== 'pointer' || e.pointerId !== press.id) return;
    if (state.phase === 'drag') cancel();
    else release();
  }

  // —— 开始拖：量好每一项的位置，之后都按这份算 ——
  function activate() {
    if (!press || state.phase !== 'idle') return;
    window.clearTimeout(press.timer);
    press.timer = undefined;
    const els = items();
    const from = press.index;
    if (!els[from]) {
      release();
      return;
    }
    rects = els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, height: r.height };
    });
    const first = rects[0] as { top: number; height: number };
    const gap = rects.length > 1 ? Math.max(0, (rects[1] as { top: number }).top - first.top - first.height) : 0;
    state.shift = (rects[from] as { height: number }).height + gap;
    // 从按下的那一点算位移：这一项一直贴着手指，不会差出"开始拖之前动的那几像素"
    startY = press.y;
    pointerY = press.lastY;
    scroller = opts.list.value ? scrollParent(opts.list.value) : null;
    startScroll = scroller?.scrollTop ?? 0;
    state.from = from;
    state.to = from;
    state.dy = 0;
    state.phase = 'drag';
    if (press.kind === 'pointer') {
      try {
        press.el.setPointerCapture(press.id);
      } catch {
        // 指针已经松开了：照样能拖完（window 上还在听）
      }
    }
    if ('vibrate' in navigator) navigator.vibrate(10);
    document.documentElement.classList.add('is-sorting');
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', cancel);
    raf = requestAnimationFrame(tick);
  }

  /** 按手指位置（加上自动滚过的距离）算被拖那一项的位移和它会落在哪 */
  function update() {
    if (state.phase !== 'drag') return;
    const from = state.from;
    const me = rects[from];
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!me || !first || !last) return;
    const scrolled = (scroller?.scrollTop ?? 0) - startScroll;
    const minDy = first.top - me.top - 8;
    const maxDy = last.top + last.height - (me.top + me.height) + 8;
    const dy = Math.min(maxDy, Math.max(minDy, pointerY - startY + scrolled));
    state.dy = dy;
    const center = me.top + me.height / 2 + dy;
    const mid = (i: number) => {
      const r = rects[i] as { top: number; height: number };
      return r.top + r.height / 2;
    };
    let to = from;
    while (to < rects.length - 1 && center > mid(to + 1)) to += 1;
    while (to > 0 && center < mid(to - 1)) to -= 1;
    state.to = to;
  }

  /** 拖到看得见的区域上下边缘时自动滚，越靠边越快 */
  function tick() {
    if (state.phase !== 'drag') return;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const top = Math.max(box.top, opts.visibleTop?.() ?? box.top);
      const bottom = box.bottom;
      const edge = Math.max(24, Math.min(64, (bottom - top) / 4));
      let v = 0;
      if (pointerY < top + edge) v = -Math.min(1.5, (top + edge - pointerY) / edge);
      else if (pointerY > bottom - edge) v = Math.min(1.5, (pointerY - (bottom - edge)) / edge);
      if (v) {
        const before = scroller.scrollTop;
        scroller.scrollTop = before + v * 14;
        if (scroller.scrollTop !== before) update();
      }
    }
    raf = requestAnimationFrame(tick);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && state.phase === 'drag') {
      e.preventDefault();
      cancel();
    }
  }

  /** 松手：落到新位置 */
  function drop() {
    const { from, to } = state;
    settle(to);
    if (to !== from) opts.onMove(from, to);
  }

  /** 取消：回到原来的位置 */
  function cancel() {
    if (state.phase === 'drag') settle(state.from);
  }

  /** 收尾：其余项立刻回到正常排布（不带动画），被拖的那项从松手的地方滑进 target */
  function settle(target: number) {
    const el = press?.el ?? null;
    const releasedTop = el?.getBoundingClientRect().top ?? 0;
    release();
    cancelAnimationFrame(raf);
    document.documentElement.classList.remove('is-sorting');
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', cancel);
    // 松手这一下浏览器紧接着会发一次 click（同一个任务里）：只吞这一次，之后的点击照常
    swallowClick = true;
    window.setTimeout(() => (swallowClick = false), 0);
    state.phase = 'drop';
    state.dropIndex = target;
    state.dropOffset = 0;
    state.dropAnimating = false;
    void nextTick(async () => {
      if (state.phase !== 'drop') return;
      const now = el?.isConnected ? el.getBoundingClientRect().top : releasedTop;
      state.dropOffset = releasedTop - now;
      await nextTick();
      void el?.offsetHeight; // 先让浏览器记下"停在松手处"的位置，下面再滑进去才有动画
      state.dropAnimating = true;
      window.clearTimeout(dropTimer);
      dropTimer = window.setTimeout(() => {
        state.phase = 'idle';
        state.dropIndex = -1;
        state.dropOffset = 0;
        state.dropAnimating = false;
      }, 200);
    });
  }

  /** 结束这次按压（不管拖没拖） */
  function release() {
    if (press?.timer) window.clearTimeout(press.timer);
    press = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  }

  /** 每一项的位移：被拖的跟着手指，其余的给它让位 */
  function styleFor(i: number): Record<string, string> | undefined {
    if (state.phase === 'idle') return undefined;
    if (state.phase === 'drag') {
      if (i === state.from) return { transform: `translate3d(0, ${state.dy}px, 0) scale(1.02)`, transition: 'box-shadow 0.15s', zIndex: '10' };
      const { from, to, shift } = state;
      let s = 0;
      if (from < to && i > from && i <= to) s = -shift;
      else if (to < from && i >= to && i < from) s = shift;
      return { transform: `translate3d(0, ${s}px, 0)`, transition: `transform 0.18s ${EASE}` };
    }
    if (i === state.dropIndex) {
      return state.dropAnimating
        ? { transform: 'translate3d(0, 0, 0)', transition: `transform 0.18s ${EASE}`, zIndex: '10' }
        : { transform: `translate3d(0, ${state.dropOffset}px, 0)`, transition: 'none', zIndex: '10' };
    }
    return { transition: 'none' };
  }

  /** 键盘：手柄上按 ↑ ↓ 挪一格，焦点跟着这一项走 */
  function onHandleKey(e: KeyboardEvent, index: number) {
    const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!d || state.phase !== 'idle') return;
    e.preventDefault();
    const to = index + d;
    if (to < 0 || to >= items().length) return;
    opts.onMove(index, to);
    void nextTick(() => items()[to]?.querySelector<HTMLElement>('[data-sort-handle]')?.focus());
  }

  // 拖完松手时那一下"点击"不算（不然会打开这一项）；长按时不弹系统菜单
  function onClickCapture(e: MouseEvent) {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }
  function onContextMenu(e: Event) {
    if (press?.kind === 'touch' || state.phase === 'drag') e.preventDefault();
  }

  function attach(el: HTMLElement) {
    // 不能是 passive：长按之后要拦住页面滚动
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchCancel);
    el.addEventListener('click', onClickCapture, true);
    el.addEventListener('contextmenu', onContextMenu);
  }
  function detach(el: HTMLElement) {
    el.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchCancel);
    el.removeEventListener('click', onClickCapture, true);
    el.removeEventListener('contextmenu', onContextMenu);
  }
  // 列表可能跟着标签页出现、消失
  watch(
    opts.list,
    (el, old) => {
      if (old) detach(old);
      if (el) attach(el);
    },
    { immediate: true, flush: 'post' },
  );
  onBeforeUnmount(() => {
    if (opts.list.value) detach(opts.list.value);
    release();
    cancelAnimationFrame(raf);
    window.clearTimeout(dropTimer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', cancel);
    document.documentElement.classList.remove('is-sorting');
  });

  return { state, styleFor, onPointerDown, onTouchStart, onHandleKey };
}
