import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { platform } from '@/pwa';

/**
 * 放映厅：一起观影时横屏、铺满整个屏幕看，弹幕照样飘在画面上。
 * - 先让整个页面进系统全屏（document.documentElement，而不是播放器：这样弹幕和按钮都在全屏里，
 *   而且能在"开始一起看"这次点击里同步调用，播放器那时还没画出来也没关系），进了全屏再锁横屏（安卓的浏览器可以）；
 * - 进不了系统全屏（iPhone 的浏览器没有这个功能）或者被拒：放映厅本身就是一个铺满屏幕、没有内边距的固定层，
 *   画面照样最大；
 * - 屏幕还是竖着的（锁不了横屏，或者开着方向锁定）：放映厅里面的内容转 90°，横过来拿手机就是横屏；
 *   手机真的转过来（系统把页面也转成横的）就不再转。
 * 进出放映厅都只改样式，不挪播放器的 DOM（iframe 一挪就会重新加载，YouTube 会从头放）。
 */

/** 手机、平板（不是电脑）：有触屏、没有鼠标悬停 */
export function isHandheld(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (platform() !== 'desktop') return true;
  try {
    return window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(hover: hover)').matches;
  } catch {
    return false;
  }
}

type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

function fullscreenElement(): Element | null {
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function isPortrait(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerHeight > window.innerWidth;
}

/** 整个页面进系统全屏：要在点击里同步调用；进去了返回 true，没有这个功能、被拒都是 false */
function requestPageFullscreen(): Promise<boolean> {
  const d = document as FsDocument;
  const el = document.documentElement as FsElement;
  const enabled = d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? false;
  if (!enabled) return Promise.resolve(false);
  try {
    if (el.requestFullscreen) {
      return el.requestFullscreen({ navigationUI: 'hide' }).then(
        () => !!fullscreenElement(),
        () => false,
      );
    }
    if (el.webkitRequestFullscreen) {
      // 老的 Safari（iPad）：不返回 Promise，等全屏事件
      return new Promise<boolean>((resolve) => {
        const done = () => {
          document.removeEventListener('webkitfullscreenchange', done);
          clearTimeout(timer);
          resolve(!!fullscreenElement());
        };
        const timer = setTimeout(done, 1500);
        document.addEventListener('webkitfullscreenchange', done);
        el.webkitRequestFullscreen!();
      });
    }
  } catch {
    // 不让全屏
  }
  return Promise.resolve(false);
}

function exitPageFullscreen() {
  const d = document as FsDocument;
  if (!fullscreenElement()) return;
  try {
    if (d.exitFullscreen) void d.exitFullscreen().catch(() => undefined);
    else d.webkitExitFullscreen?.();
  } catch {
    // 已经退出了
  }
}

export function useTheater(target: Ref<HTMLElement | null>) {
  /** 在放映厅里 */
  const on = ref(false);
  /** 进了系统全屏（没进也照样铺满屏幕，只是浏览器的地址栏、系统状态栏还在） */
  const fullscreen = ref(false);
  /** 锁横屏成功了 */
  const locked = ref(false);
  /** 正在进全屏、锁横屏：这时先不转，免得转过去又转回来 */
  const settling = ref(false);
  const portrait = ref(isPortrait());
  /** 放映厅这一层的大小（就是屏幕上能用的那一块） */
  const size = ref({ w: 0, h: 0 });

  /** 屏幕是竖的：里面的内容转 90° 变成横屏 */
  const rotate = computed(() => on.value && portrait.value && !settling.value);
  /** 里面的内容按多大排（转了的话宽高对调） */
  const box = computed(() => (rotate.value ? { w: size.value.h, h: size.value.w } : { ...size.value }));

  let ro: ResizeObserver | null = null;
  function measure() {
    const el = target.value;
    if (el) size.value = { w: el.clientWidth, h: el.clientHeight };
    portrait.value = isPortrait();
  }
  watch(
    target,
    (el) => {
      ro?.disconnect();
      ro = null;
      if (!el) return;
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(el);
      }
    },
    { immediate: true, flush: 'post' },
  );
  const onResize = () => measure();
  const onFsChange = () => {
    // 用系统的返回手势 / 返回键退出了全屏：一起退出放映厅
    if (fullscreen.value && !fullscreenElement()) exit();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
  }

  /** 进放映厅。要在点击的处理函数里同步调用（系统全屏只认用户刚点过） */
  function enter() {
    if (on.value) return;
    on.value = true;
    settling.value = true;
    const asked = requestPageFullscreen();
    void (async () => {
      const ok = await asked;
      if (!on.value) {
        if (ok) exitPageFullscreen();
        return;
      }
      fullscreen.value = ok;
      if (ok) {
        const o = (typeof screen !== 'undefined' ? screen.orientation : undefined) as LockableOrientation | undefined;
        try {
          if (!o?.lock) throw new Error('不能锁方向');
          await o.lock('landscape');
          locked.value = true;
          // 转屏的 resize 有时比 Promise 晚一点到
          await new Promise((r) => setTimeout(r, 250));
        } catch {
          locked.value = false;
        }
      }
      measure();
      settling.value = false;
    })();
  }

  /** 出放映厅：退出系统全屏、解开方向锁 */
  function exit() {
    if (!on.value) return;
    on.value = false;
    settling.value = false;
    if (locked.value) {
      try {
        (screen.orientation as LockableOrientation).unlock?.();
      } catch {
        // 没锁上
      }
    }
    locked.value = false;
    fullscreen.value = false;
    exitPageFullscreen();
  }

  onBeforeUnmount(() => {
    exit();
    ro?.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    }
  });

  return { on, fullscreen, locked, rotate, size, box, enter, exit };
}
