<script setup lang="ts">
import { EXPRESSION_LABELS, EXPRESSIONS, expressionMood, type Character, type CharacterLive2D, type Live2DOutfit } from '@app/shared';
import { computed, onBeforeUnmount, ref } from 'vue';
import { showToast } from 'vant';
import Live2DAvatar from '@/components/call/Live2DAvatar.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import { write } from '@/db/idb';
import { ACTION_LABELS } from '@/live2d/cues';
import { importModel } from '@/live2d/import';
import { Live2DRenderer } from '@/live2d/renderer';
import { useCharacterStore } from '@/stores/characters';
import { uid } from '@/utils/id';

const props = defineProps<{ character: Character }>();
const config = computed(() => props.character.live2d);
const busy = ref(false);
const progress = ref('');
const error = ref('');
/** 映射哪些表情：她有立绘时是立绘上她自己的表情，没有时是占位小人那几种 */
const faces = computed(() => {
  const own = props.character.portraits?.expressions ?? [];
  return own.length ? own.map((e) => ({ id: e.id, label: e.label, own: true })) : EXPRESSIONS.map((e) => ({ id: e, label: EXPRESSION_LABELS[e], own: false }));
});
const expression = ref(props.character.portraits?.defaultExpression || faces.value[0]?.id || 'neutral');
/** 她自己的表情没单独设时，按名字猜成的那种情绪用的是哪个 */
function autoName(id: string, map: Record<string, string>): string {
  return map[expressionMood(id, props.character.portraits)] || map.neutral || '';
}
const text = ref('');
const sentence = ref(0);
const previewOutfit = ref('');
const zoom = computed({
  get: () => Math.round((config.value?.framing?.zoom ?? 1) * 100),
  set: (value: number) => { if (config.value) config.value.framing = { zoom: value / 100 }; },
});
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
      Object.assign(imported.config, check.settings());
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
    previewOutfit.value = '';
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
function rememberSettings(settings: Pick<CharacterLive2D, 'parameters' | 'outfits' | 'defaultOutfit'>) {
  if (!config.value) return;
  config.value.parameters = settings.parameters;
  config.value.outfits ??= settings.outfits;
  config.value.defaultOutfit ??= settings.defaultOutfit;
}
function addOutfit() {
  if (!config.value) return;
  const outfit = { id: uid('outfit'), name: '新衣着', match: '', parameters: {} };
  (config.value.outfits ??= []).push(outfit);
  previewOutfit.value = outfit.id;
}
function removeOutfit(outfit: Live2DOutfit) {
  if (!config.value) return;
  config.value.outfits = config.value.outfits?.filter(o => o.id !== outfit.id);
  if (config.value.defaultOutfit === outfit.id) config.value.defaultOutfit = config.value.outfits?.[0]?.id;
  if (previewOutfit.value === outfit.id) previewOutfit.value = '';
}
function addParameter(outfit: Live2DOutfit, event: Event) {
  const input = event.target as HTMLSelectElement;
  const parameter = config.value?.parameters?.find(p => p.id === input.value);
  if (parameter) outfit.parameters[parameter.id] = parameter.default;
  input.value = '';
}
function parameter(id: string) { return config.value?.parameters?.find(p => p.id === id); }
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
        <Live2DAvatar :config="config" :expression="expression" :text="text" :sentence="sentence" :preview-outfit="previewOutfit" @ready="rememberSettings" />
      </div>
      <div class="framing-control">
        <label for="live2d-zoom">人物大小 <output>{{ zoom }}%</output></label>
        <input id="live2d-zoom" v-model.number="zoom" type="range" min="70" max="160" step="1" aria-label="人物大小" />
        <button type="button" @click="zoom = 100">恢复自动比例</button>
      </div>
      <p class="hint">已按这份模型的可见轮廓自动适配、保持比例并贴底。可微调大小，设置会随角色保存。</p>
      <div class="preview-controls">
        <label>预览表情 <select v-model="expression" aria-label="预览表情"><option v-for="e in faces" :key="e.id" :value="e.id">{{ e.label }}</option></select></label>
        <button type="button" @click="action('你好')">挥手</button><button type="button" @click="action('好的')">点头</button><button type="button" @click="action('不行')">摇头</button>
      </div>
      <div class="outfit-controls">
        <label>默认衣着<select v-model="config.defaultOutfit" aria-label="默认衣着"><option v-for="outfit in config.outfits" :key="outfit.id" :value="outfit.id">{{ outfit.name }}</option></select></label>
        <label>预览衣着<select v-model="previewOutfit" aria-label="预览衣着"><option value="">跟随默认衣着</option><option v-for="outfit in config.outfits" :key="outfit.id" :value="outfit.id">{{ outfit.name }}</option></select></label>
      </div>
      <p class="hint">视频通话会匹配角色节律中的衣着名称或标签；没有匹配项时使用上面设置的默认衣着。</p>
      <details class="outfit-settings">
        <summary>衣着匹配与模型参数</summary>
        <p class="hint">为模型已有的衣着填写名称和匹配词（逗号分隔）。未自动识别的换装，可新增衣着并选择模型的换装参数。素材本身需要包含对应服装。</p>
        <div v-for="outfit in config.outfits" :key="outfit.id" class="outfit-editor">
          <label>衣着名称<input v-model="outfit.name" :aria-label="`${outfit.id}衣着名称`" /></label>
          <label>匹配词<input v-model="outfit.match" :aria-label="`${outfit.id}衣着匹配词`" placeholder="如：族服,clan" /></label>
          <div v-for="(_, id) in outfit.parameters" :key="id" class="outfit-parameter">
            <label :for="`${outfit.id}-${id}`">{{ parameter(id)?.name ?? id }}</label>
            <input :id="`${outfit.id}-${id}`" v-model.number="outfit.parameters[id]" type="number" :min="parameter(id)?.min" :max="parameter(id)?.max" step="any" :aria-label="`${outfit.id}-${id}`" />
            <button type="button" :aria-label="`移除${outfit.id}的${id}参数`" @click="delete outfit.parameters[id]">移除</button>
          </div>
          <select :aria-label="`${outfit.id}添加换装参数`" value="" @change="addParameter(outfit, $event)"><option value="">添加换装参数…</option><option v-for="p in config.parameters?.filter(p => !(p.id in outfit.parameters))" :key="p.id" :value="p.id">{{ p.name }} · {{ p.id }}</option></select>
          <div class="outfit-actions"><button type="button" @click="previewOutfit = outfit.id">预览这套</button><button v-if="(config.outfits?.length ?? 0) > 1" type="button" @click="removeOutfit(outfit)">删除这套</button></div>
        </div>
        <button type="button" class="add-outfit" @click="addOutfit">新增衣着</button>
      </details>
      <RouterLink :to="`/call/${character.id}?video=1`" class="start-video"><span class="i-lucide-video" />开始视频通话</RouterLink>
      <details>
        <summary>表情与动作映射</summary>
        <p class="hint">{{ faces[0]?.own ? `按${character.name}立绘上的表情列出；没单独选的按名字自动找最像的。` : '已按名称匹配。' }}可为每个表情改选模型实际导出的表情和动作；未匹配时保持自然待机。</p>
        <div v-for="e in faces" :key="e.id" class="binding">
          <label>{{ e.label }}</label>
          <select v-model="config.expressionMap[e.id]" :aria-label="`${e.label}表情映射`"><option value="">{{ e.own ? `自动（${autoName(e.id, config.expressionMap) || '默认表情'}）` : '默认表情' }}</option><option v-for="name in config.expressions" :key="name" :value="name">{{ name }}</option></select>
          <select v-model="config.motionMap[e.id]" :aria-label="`${e.label}动作映射`"><option value="">{{ e.own && autoName(e.id, config.motionMap) ? `自动（${autoName(e.id, config.motionMap)}）` : '自然动作' }}</option><option v-for="name in config.motions" :key="name" :value="name">{{ name }}</option></select>
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
.framing-control { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 12px; }
.framing-control label { white-space: nowrap; }
.framing-control input { min-width: 40px; flex: 1; accent-color: var(--accent); }
.framing-control button { color: var(--accent); font-size: 12px; }
.outfit-controls { display: flex; gap: 12px; }
.outfit-controls label { flex: 1; min-width: 0; display: grid; gap: 6px; font-size: 13px; }
.outfit-editor { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; margin: 10px 0; font-size: 12px; }
.outfit-editor > label { display: grid; gap: 5px; }
.outfit-editor input { min-width: 0; width: 100%; padding: 8px; border-radius: 8px; border: 1px solid var(--line); color: var(--ink); background: var(--surface); }
.outfit-parameter { display: grid; grid-template-columns: minmax(0, 1fr) 64px 32px; align-items: center; gap: 8px; }
.outfit-parameter label { overflow-wrap: anywhere; }
.outfit-actions { display: flex; justify-content: space-between; color: var(--accent); }
.add-outfit { color: var(--accent); padding: 8px 0; }
.start-video { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 13px; border-radius: 24px; color: var(--on-accent); background: var(--accent); margin: 16px 0; }
summary { padding: 10px 0; cursor: pointer; font-size: 14px; }
.binding { display: grid; grid-template-columns: 52px minmax(0, 1fr) minmax(0, 1fr); gap: 6px; align-items: center; font-size: 12px; margin: 8px 0; }
.remove { color: var(--ink-3); font-size: 12px; text-decoration: underline; margin-top: 20px; }
</style>
