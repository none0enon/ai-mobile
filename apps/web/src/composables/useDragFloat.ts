import { computed, ref, type Ref } from 'vue';

export interface FloatPos {
  /** 0 靠左，1 靠右 */
  x: number;
  /** 0 靠上，1 靠下 */
  y: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * 按住拖着走的浮层（健身的计时器）。浮层绝对定位在一个划好范围的父元素里，位置记成"能放的范围里的比例"：
 * 父元素大小变了（转屏、弹键盘）还在差不多的地方，也拖不出去。
 * 按下后挪了几个像素才算拖：没挪就是普通的点按，里面的按钮照常能点；拖过的这一下，松手时的那次点击吞掉。
 */
export function useDragFloat(pos: Ref<FloatPos>, onDrop?: (p: FloatPos) => void) {
  const el = ref<HTMLElement | null>(null);
  const dragging = ref(false);
  let start: { id: number; x: number; y: number; left: number; top: number } | null = null;
  let swallowClick = false;

  function room() {
    const node = el.value;
    const parent = node?.offsetParent as HTMLElement | null;
    if (!node || !parent) return null;
    return { w: parent.clientWidth - node.offsetWidth, h: parent.clientHeight - node.offsetHeight, node };
  }

  function onPointerDown(e: PointerEvent) {
    swallowClick = false;
    const r = room();
    if (!r || (e.pointerType === 'mouse' && e.button !== 0)) return;
    start = { id: e.pointerId, x: e.clientX, y: e.clientY, left: pos.value.x * Math.max(0, r.w), top: pos.value.y * Math.max(0, r.h) };
  }

  function onPointerMove(e: PointerEvent) {
    if (!start || e.pointerId !== start.id) return;
    const r = room();
    if (!r) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragging.value) {
      if (Math.hypot(dx, dy) < 6) return;
      dragging.value = true;
      r.node.setPointerCapture?.(e.pointerId);
    }
    pos.value = { x: r.w > 0 ? clamp01((start.left + dx) / r.w) : 0, y: r.h > 0 ? clamp01((start.top + dy) / r.h) : 0 };
  }

  function onPointerUp(e: PointerEvent) {
    if (!start || e.pointerId !== start.id) return;
    start = null;
    if (!dragging.value) return;
    dragging.value = false;
    swallowClick = e.type === 'pointerup';
    onDrop?.(pos.value);
  }

  function onClickCapture(e: MouseEvent) {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }

  /** left / top 按比例放，再用 translate 退回自己宽高的同样比例：0 贴左上，1 贴右下 */
  const style = computed(() => {
    const x = clamp01(pos.value.x) * 100;
    const y = clamp01(pos.value.y) * 100;
    return { left: `${x}%`, top: `${y}%`, transform: `translate(${-x}%, ${-y}%)` };
  });

  const listeners = {
    pointerdown: onPointerDown,
    pointermove: onPointerMove,
    pointerup: onPointerUp,
    pointercancel: onPointerUp,
  };

  return { el, dragging, style, listeners, onClickCapture };
}
