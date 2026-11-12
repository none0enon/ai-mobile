<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { cameraSupported } from '@/utils/camera';

/**
 * 聊天 ＋ → 拍照：App 里直接开相机（navigator.mediaDevices.getUserMedia，第一次会弹系统 / 浏览器的相机权限）。
 * 前后摄像头可以切换，拍完先看一眼：重拍或者用这张。
 * 用不了（没给权限、没有相机、不是 https、浏览器不支持）时写明原因，可以改用系统相机拍（<input capture>）或从相册选。
 */
const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'shot', photo: Blob): void;
  /** 改用系统相机 / 相册（要在点击里打开文件框，交给外面） */
  (e: 'system-camera'): void;
  (e: 'album'): void;
}>();

const video = ref<HTMLVideoElement | null>(null);
const facing = ref<'environment' | 'user'>('environment');
const canFlip = ref(false);
const starting = ref(false);
const error = ref('');
const shot = ref<{ blob: Blob; url: string } | null>(null);
let stream: MediaStream | null = null;

function stopStream() {
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  if (video.value) video.value.srcObject = null;
}

function reason(e: unknown): string {
  const name = (e as DOMException)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '没有相机权限：在浏览器的网站设置里允许这个网站使用相机（iPhone：设置 → Safari → 相机；装成 App 的在系统设置里找这个 App），或者改用系统相机拍';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '这台设备上没找到相机';
  if (name === 'NotReadableError' || name === 'AbortError') return '相机被别的 App 占着，关掉它再试';
  return `相机打不开：${e instanceof Error ? e.message : String(e)}`;
}

async function start() {
  error.value = '';
  if (!cameraSupported()) {
    error.value = window.isSecureContext ? '这个浏览器不能在网页里开相机，改用系统相机拍' : '相机要在 https 页面里用（局域网 http 地址不行），改用系统相机拍';
    return;
  }
  starting.value = true;
  stopStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing.value }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    if (!props.show) {
      stopStream();
      return;
    }
    await nextTick();
    if (video.value) {
      video.value.srcObject = stream;
      await video.value.play().catch(() => undefined);
    }
    const cams = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
    canFlip.value = cams.length > 1;
  } catch (e) {
    error.value = reason(e);
  } finally {
    starting.value = false;
  }
}

function close() {
  stopStream();
  dropShot();
  emit('update:show', false);
}

function flip() {
  facing.value = facing.value === 'environment' ? 'user' : 'environment';
  void start();
}

/** 拍：取这一帧（前摄像头和预览一样左右翻过来） */
async function capture() {
  const v = video.value;
  if (!v || !v.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (facing.value === 'user') {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) {
    error.value = '没拍下来，再试一次';
    return;
  }
  shot.value = { blob, url: URL.createObjectURL(blob) };
  v.pause();
}

function dropShot() {
  if (shot.value) URL.revokeObjectURL(shot.value.url);
  shot.value = null;
}
function retake() {
  dropShot();
  void video.value?.play().catch(() => undefined);
}
function use() {
  const s = shot.value;
  if (!s) return;
  emit('shot', s.blob);
  close();
}

watch(
  () => props.show,
  (on) => {
    if (on) void start();
    else {
      stopStream();
      dropShot();
    }
  },
  { immediate: true },
);
// 切到后台就关掉相机（iPhone 上不关的话状态栏一直亮着绿点）
function onHide() {
  if (document.hidden && props.show) close();
}
document.addEventListener('visibilitychange', onHide);
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onHide);
  stopStream();
  dropShot();
});

const mirrored = computed(() => facing.value === 'user');
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="camera" role="dialog" aria-modal="true" aria-label="拍照" data-testid="camera-sheet">
      <video v-show="!shot && !error" ref="video" class="preview" :class="{ mirrored }" playsinline muted autoplay />
      <img v-if="shot" :src="shot.url" class="preview" alt="刚拍的照片" />
      <div v-if="error" class="cam-error" role="alert">
        <span class="i-lucide-camera-off text-[34px]" />
        <p>{{ error }}</p>
        <div class="flex flex-col gap-2 w-full max-w-[260px]">
          <button class="cam-btn primary" @click="emit('system-camera')"><span class="i-lucide-camera" />用系统相机拍</button>
          <button class="cam-btn" @click="emit('album')"><span class="i-lucide-image" />从相册选</button>
          <button v-if="cameraSupported()" class="cam-btn" @click="start"><span class="i-lucide-refresh-cw" />再试一次</button>
        </div>
      </div>
      <div v-else-if="starting" class="cam-hint">正在打开相机…（第一次要允许使用相机）</div>

      <header class="cam-top">
        <button class="cam-icon" aria-label="关闭" @click="close"><span class="i-lucide-x" /></button>
        <span class="flex-1" />
        <button v-if="canFlip && !shot && !error" class="cam-icon" aria-label="切换前后摄像头" @click="flip"><span class="i-lucide-switch-camera" /></button>
      </header>

      <footer v-if="!error" class="cam-bottom">
        <template v-if="shot">
          <button class="cam-btn" @click="retake"><span class="i-lucide-undo-2" />重拍</button>
          <button class="cam-btn primary" data-testid="camera-use" @click="use"><span class="i-lucide-check" />用这张</button>
        </template>
        <template v-else>
          <button class="cam-side" aria-label="从相册选" @click="emit('album')"><span class="i-lucide-image" /></button>
          <button class="shutter" aria-label="拍照" :disabled="starting" data-testid="camera-shutter" @click="capture"><span /></button>
          <button class="cam-side" aria-label="用系统相机拍" @click="emit('system-camera')"><span class="i-lucide-aperture" /></button>
        </template>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.camera {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: #000;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.preview.mirrored {
  transform: scaleX(-1);
}
.cam-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  padding: calc(var(--safe-top) + 10px) 14px 10px;
}
.cam-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  font-size: 22px;
}
.cam-bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 16px;
  padding: 18px 24px calc(var(--safe-bottom) + 24px);
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
}
.shutter {
  width: 74px;
  height: 74px;
  border-radius: 50%;
  border: 4px solid #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.shutter span {
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.shutter:active span {
  transform: scale(0.88);
}
.shutter:disabled {
  opacity: 0.5;
}
.cam-side {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.16);
  font-size: 22px;
}
.cam-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 44px;
  padding: 0 20px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.16);
  font-size: 15px;
  font-weight: 600;
}
.cam-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
}
.cam-error,
.cam-hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  text-align: center;
  font-size: 14px;
  line-height: 1.6;
}
.cam-hint {
  color: rgba(255, 255, 255, 0.75);
  pointer-events: none;
}
</style>
