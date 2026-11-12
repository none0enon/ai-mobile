<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAppStore } from '@/stores/app';
import { broadcastFrameEvent, buildFrameDoc, FRAME_MAX_HEIGHT, postFrameState, registerFrame, type FrameState } from '@/utils/frames';
import { uid } from '@/utils/id';

/**
 * 消息里的一个"HTML 界面"：``` 代码块里的整页 HTML 放进沙盒小窗运行（见 utils/frames.ts），高度跟着内容走。
 * 第几条、最后一条、日夜只在建页面时写进去，之后变了用 postMessage 告诉它：
 * 新消息来了、换了主题都不重新加载页面（不然播放器会从头放）
 */
const props = defineProps<{ code: string; messageIndex: number; lastIndex: number }>();

const app = useAppStore();
const id = uid('frame');
const el = ref<HTMLIFrameElement | null>(null);
const height = ref(160);
const ready = ref(false);
const initial: FrameState = { messageId: props.messageIndex, lastMessageId: props.lastIndex, theme: app.resolvedTheme };
const viewportHeight = window.innerHeight;
const srcdoc = computed(() => buildFrameDoc(props.code, id, initial, viewportHeight));

// 写错的页面（高度 100% 再加内边距）会一点点越撑越高：连续变高很多次就不再跟
let grows: number[] = [];
function setHeight(h: number) {
  const next = Math.min(FRAME_MAX_HEIGHT, Math.max(24, Math.ceil(h)));
  const now = Date.now();
  if (next > height.value && ready.value) {
    grows = [...grows.filter((t) => now - t < 2000), now];
    if (grows.length > 12) return;
  }
  height.value = next;
  ready.value = true;
}

function onMessage(e: MessageEvent) {
  if (!el.value || e.source !== el.value.contentWindow) return;
  const d = e.data as { __aiMobile?: string; type?: string; height?: unknown; name?: unknown; args?: unknown } | null;
  if (!d || typeof d !== 'object' || d.__aiMobile !== id) return;
  if (d.type === 'height' && typeof d.height === 'number' && Number.isFinite(d.height)) setHeight(d.height);
  else if (d.type === 'event' && typeof d.name === 'string') broadcastFrameEvent(d.name, Array.isArray(d.args) ? d.args : []);
}

let unregister: (() => void) | undefined;
onMounted(() => {
  window.addEventListener('message', onMessage);
  unregister = registerFrame(id, () => el.value?.contentWindow ?? null);
});
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  unregister?.();
});
// 代码变了（改了这条消息）：页面重新加载，高度重新量
watch(srcdoc, () => {
  ready.value = false;
  grows = [];
});
watch(
  () => [props.messageIndex, props.lastIndex, app.resolvedTheme] as const,
  ([messageId, lastMessageId, theme]) => postFrameState(id, el.value?.contentWindow, { messageId, lastMessageId, theme }),
);
</script>

<template>
  <div class="html-frame" :class="{ ready }" data-testid="html-frame">
    <iframe
      ref="el"
      :srcdoc="srcdoc"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
      allow="autoplay; fullscreen"
      referrerpolicy="no-referrer"
      title="HTML 页面"
      :style="{ height: `${height}px` }"
    />
  </div>
</template>

<style scoped>
.html-frame {
  width: 100%;
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
  transition: background 0.2s;
}
.html-frame.ready {
  background: transparent;
}
/* 不另设 color-scheme：和 App 的日夜一致，页面里也写了同样的，没写背景的界面是透明的 */
iframe {
  display: block;
  width: 100%;
  border: 0;
}
</style>
