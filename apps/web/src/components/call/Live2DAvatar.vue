<script setup lang="ts">
import type { CharacterLive2D } from '@app/shared';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getOne } from '@/db/idb';
import type { ModelPackage } from '@/live2d/model';
import { Live2DRenderer } from '@/live2d/renderer';

const props = withDefaults(defineProps<{ config: CharacterLive2D; expression?: string; text?: string; sentence?: number; level?: number; audible?: boolean }>(), { expression: 'neutral', text: '', sentence: 0, level: 0, audible: false });
const canvas = ref<HTMLCanvasElement>();
const canvasKey = ref(0);
const loading = ref(true);
const error = ref('');
let avatar: Live2DRenderer | undefined;
let generation = 0;
let mounted = false;

function syncCue() { avatar?.setCue(props.expression, props.text); }
function syncAudio() { avatar?.setAudio(props.level, props.audible); }
async function load() {
  const token = ++generation;
  avatar?.dispose();
  avatar = undefined;
  loading.value = true;
  error.value = '';
  // A lost WebGL context belongs to its canvas; retry with a fresh surface.
  canvasKey.value++;
  await nextTick();
  if (token !== generation) return;
  try {
    const model = await getOne<ModelPackage>('live2d', props.config.assetId);
    if (token !== generation || !canvas.value) return;
    if (!model) throw new Error('这台设备还没有模型文件，请到角色设定重新上传');
    const instance = await Live2DRenderer.create(canvas.value, model, props.config, message => {
      if (token === generation) error.value = message;
    });
    if (token !== generation) { instance.dispose(); return; }
    avatar = instance;
    syncCue();
    syncAudio();
  } catch (e) { if (token === generation) error.value = e instanceof Error ? e.message : '模型加载失败'; }
  finally { if (token === generation) loading.value = false; }
}
watch(() => props.config.assetId, () => { if (mounted) void load(); });
watch(() => [props.expression, props.text, props.sentence, props.config.expressionMap, props.config.motionMap], syncCue, { deep: true });
watch(() => [props.level, props.audible], syncAudio, { flush: 'sync' });
onMounted(() => { mounted = true; void load(); });
onBeforeUnmount(() => { generation++; avatar?.dispose(); });
defineExpose({ snapshot: () => avatar?.snapshot() });
</script>

<template>
  <div class="live2d-avatar" :data-state="error ? 'error' : loading ? 'loading' : 'ready'" data-testid="live2d-avatar">
    <canvas :key="canvasKey" ref="canvas" :class="{ hidden: loading || error }" aria-label="Live2D 角色" />
    <div v-if="loading || error" class="model-message" role="status">
      <span>{{ error || '正在加载角色…' }}</span>
      <button v-if="error" type="button" @click="load">重试</button>
    </div>
  </div>
</template>

<style scoped>
.live2d-avatar { position: relative; width: 100%; height: 100%; min-height: 120px; }
canvas { display: block; width: 100%; height: 100%; }
canvas.hidden { opacity: 0; }
.model-message { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px; padding: 24px; text-align: center; font-size: 13px; }
.model-message button { border: 1px solid currentColor; border-radius: 20px; padding: 6px 18px; }
</style>
