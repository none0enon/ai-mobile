<script setup lang="ts">
import { EXPRESSION_LABELS, EXPRESSIONS, type Character } from '@app/shared';
import { computed, onBeforeUnmount, ref } from 'vue';
import { showToast } from 'vant';
import Live2DAvatar from '@/components/call/Live2DAvatar.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import { write } from '@/db/idb';
import { ACTION_LABELS } from '@/live2d/cues';
import { importModel } from '@/live2d/import';
import { Live2DRenderer } from '@/live2d/renderer';
import { useCharacterStore } from '@/stores/characters';

const props = defineProps<{ character: Character }>();
const config = computed(() => props.character.live2d);
const busy = ref(false);
const progress = ref('');
const error = ref('');
const expression = ref('neutral');
const text = ref('');
const sentence = ref(0);
const zip = ref<HTMLInputElement>();
const folder = ref<HTMLInputElement>();
let mounted = true;
onBeforeUnmount(() => { mounted = false; });

async function pick(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length || busy.value) return;
  const target = props.character;
  busy.value = true;
  error.value = '';
  progress.value = '正在读取模型清单…';
  try {
    const imported = await importModel(files, message => { progress.value = message; });
    if (!mounted) return;
    progress.value = '正在检查模型和纹理…';
    let renderError = '';
    const check = await Live2DRenderer.create(document.createElement('canvas'), imported.model, imported.config, message => { renderError = message; });
    try {
      await new Promise(requestAnimationFrame);
      if (renderError) throw new Error(renderError);
    } finally { check.dispose(); }
    if (!mounted) return;
    progress.value = '正在保存到这台设备…';
    if (!await write('live2d', [{ key: imported.config.assetId, value: imported.model }])) throw new Error('本机存储空间不足或不可用，原模型已保留');
    const saved = { ...JSON.parse(JSON.stringify(target)), live2d: imported.config, updatedAt: Date.now() };
    if (!await write('characters', [{ key: target.id, value: saved }])) {
      await write('live2d', [], [imported.config.assetId]);
      throw new Error('角色设置保存失败，原模型已保留');
    }
    const previous = target.live2d?.assetId;
    target.live2d = imported.config;
    target.updatedAt = saved.updatedAt;
    if (previous && !useCharacterStore().list.some(c => c.id !== target.id && c.live2d?.assetId === previous)) await write('live2d', [], [previous]);
    showToast('Live2D 已保存，可以视频通话了');
  } catch (e) { error.value = e instanceof Error ? e.message : '模型上传失败'; }
  finally { busy.value = false; }
}

async function remove() {
  const target = props.character;
  const id = target.live2d?.assetId;
  if (!id) return;
  const saved = JSON.parse(JSON.stringify(target)) as Character;
  delete saved.live2d;
  saved.updatedAt = Date.now();
  if (!await write('characters', [{ key: target.id, value: saved }])) { error.value = '移除失败，请重试'; return; }
  delete target.live2d;
  target.updatedAt = saved.updatedAt;
  if (!useCharacterStore().list.some(c => c.live2d?.assetId === id)) await write('live2d', [], [id]);
}
function action(value: string) { text.value = value; sentence.value++; }
</script>

<template>
  <section class="model-settings">
    <p>上传角色的 Live2D 模型，视频通话时会自动眨眼，随声音开口，并跟随情绪和对话做动作。</p>
    <input ref="zip" hidden type="file" accept=".zip,application/zip" aria-label="上传 Live2D ZIP" data-testid="live2d-upload" @change="pick" />
    <input ref="folder" hidden type="file" webkitdirectory multiple aria-label="上传 Live2D 文件夹" @change="pick" />
    <div class="pick-actions">
      <van-button round type="primary" :loading="busy" :disabled="busy" @click="zip?.click()">{{ config ? '更换 ZIP 模型' : '上传 ZIP 模型' }}</van-button>
      <van-button round :disabled="busy" @click="folder?.click()">选择文件夹</van-button>
    </div>
    <p class="hint">支持 Cubism 3/4/5。ZIP 可包含多层目录；保留 .model3.json 引用的 MOC3、纹理、表情和动作。模型保存在这台设备上。</p>
    <p v-if="busy" role="status">{{ progress }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="config">
      <div class="model-info"><strong>{{ config.name }}</strong><span>{{ (config.bytes / 1048576).toFixed(1) }} MB · {{ config.fileCount }} 个运行文件</span></div>
      <div v-if="!busy" class="preview">
        <SceneBackdrop kind="room" tod="afternoon" />
        <Live2DAvatar :config="config" :expression="expression" :text="text" :sentence="sentence" />
      </div>
      <div class="preview-controls">
        <label>预览表情 <select v-model="expression" aria-label="预览表情"><option v-for="e in EXPRESSIONS" :key="e" :value="e">{{ EXPRESSION_LABELS[e] }}</option></select></label>
        <button type="button" @click="action('你好')">挥手</button><button type="button" @click="action('好的')">点头</button><button type="button" @click="action('不行')">摇头</button>
      </div>
      <RouterLink :to="`/call/${character.id}?video=1`" class="start-video"><span class="i-lucide-video" />开始视频通话</RouterLink>
      <details>
        <summary>表情与动作映射</summary>
        <p class="hint">已按名称匹配。可为每种情绪改选模型实际导出的表情和动作；未匹配时保持自然待机。</p>
        <div v-for="e in EXPRESSIONS" :key="e" class="binding">
          <label>{{ EXPRESSION_LABELS[e] }}</label>
          <select v-model="config.expressionMap[e]" :aria-label="`${EXPRESSION_LABELS[e]}表情映射`"><option value="">默认表情</option><option v-for="name in config.expressions" :key="name" :value="name">{{ name }}</option></select>
          <select v-model="config.motionMap[e]" :aria-label="`${EXPRESSION_LABELS[e]}动作映射`"><option value="">自然动作</option><option v-for="name in config.motions" :key="name" :value="name">{{ name }}</option></select>
        </div>
        <div v-for="(label, key) in ACTION_LABELS" :key="key" class="binding"><label>{{ label }}</label><select v-model="config.motionMap[key]" :aria-label="`${label}动作映射`"><option value="">自动</option><option v-for="name in config.motions" :key="name" :value="name">{{ name }}</option></select></div>
      </details>
      <button type="button" class="remove" :disabled="busy" @click="remove">移除 Live2D 模型</button>
    </template>
  </section>
</template>

<style scoped>
.model-settings { padding: 4px 16px 24px; }
p { font-size: 13px; line-height: 1.7; }
.hint { color: var(--ink-3); font-size: 12px; }
.pick-actions, .preview-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.error { color: var(--danger, #d44); }
.model-info { display: grid; gap: 4px; margin: 16px 0 10px; overflow-wrap: anywhere; }
.model-info span { font-size: 12px; color: var(--ink-3); }
.preview { height: 350px; position: relative; border-radius: 20px; overflow: hidden; }
.preview-controls { margin: 12px 0; font-size: 12px; }
select { padding: 7px 4px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); min-width: 0; max-width: 100%; }
.preview-controls button { padding: 7px 10px; background: var(--accent-soft); border-radius: 12px; }
.start-video { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 13px; border-radius: 24px; color: var(--on-accent); background: var(--accent); margin: 16px 0; }
summary { padding: 10px 0; cursor: pointer; font-size: 14px; }
.binding { display: grid; grid-template-columns: 52px minmax(0, 1fr) minmax(0, 1fr); gap: 6px; align-items: center; font-size: 12px; margin: 8px 0; }
.remove { color: var(--ink-3); font-size: 12px; text-decoration: underline; margin-top: 20px; }
</style>
