<script setup lang="ts">
import { showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import { AVATAR_FIELDS, randomAvatar, type Avatar } from './avatar';
import { ChibiStudio } from './studio';

/**
 * 捏人：你和她两个小人，挑发型、发顶、刘海（能左右翻转、发梢渐变）、眼睛、嘴、衣服或套装（颜色 + 花纹）、能多选的配饰，拖着展示台转着看。
 * "让她捏"：她照自己的设定给自己捏（或者照你的人设给你捏），捏出来先放进草稿，你还能接着改；点"好了"才存。
 */
const props = defineProps<{ you: Avatar; her: Avatar; herName: string; herPronoun: string; start: 'you' | 'her'; design: (who: 'you' | 'her') => Promise<Avatar | null> }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ save: [who: 'you' | 'her', avatar: Avatar] }>();

type Group = 'face' | 'hair' | 'clothes' | 'more';
const GROUPS: { value: Group; label: string }[] = [
  { value: 'face', label: '脸' },
  { value: 'hair', label: '头发' },
  { value: 'clothes', label: '衣服' },
  { value: 'more', label: '配饰和体型' },
];

const who = ref<'you' | 'her'>(props.start);
const group = ref<Group>('face');
const draft = ref<{ you: Avatar; her: Avatar }>({ you: { ...props.you }, her: { ...props.her } });
const current = computed(() => draft.value[who.value]);
const fields = computed(() => AVATAR_FIELDS.filter((f) => f.group === group.value && (!f.when || f.when(current.value))));
const whoOptions = computed(() => [
  { value: 'you' as const, label: '你' },
  { value: 'her' as const, label: props.herName },
]);
const designing = ref(false);
const canvas = ref<HTMLCanvasElement | null>(null);
let studio: ChibiStudio | null = null;

watch(show, async (open) => {
  if (open) {
    who.value = props.start;
    draft.value = { you: { ...props.you }, her: { ...props.her } };
    await nextTick();
    if (canvas.value && !studio) studio = new ChibiStudio(canvas.value, current.value);
  } else {
    studio?.dispose();
    studio = null;
  }
});
onBeforeUnmount(() => studio?.dispose());
watch(current, (a) => studio?.setAvatar(a), { deep: true });

function set<K extends keyof Avatar>(key: K, value: Avatar[K]) {
  draft.value = { ...draft.value, [who.value]: { ...current.value, [key]: value } };
}
/** 多选的一项（配饰）：点一下戴上，再点一下摘掉 */
function toggleIn(key: keyof Avatar, id: string) {
  const list = current.value[key] as string[];
  set(key, (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]) as never);
}
function picked(key: keyof Avatar, id: string, multi?: boolean): boolean {
  const v = current.value[key];
  return multi ? (v as string[]).includes(id) : v === id;
}
function shuffle() {
  draft.value = { ...draft.value, [who.value]: randomAvatar(current.value) };
  studio?.wave();
}
async function letHerDesign() {
  if (designing.value) return;
  designing.value = true;
  const target = who.value;
  try {
    const a = await props.design(target);
    if (a) {
      draft.value = { ...draft.value, [target]: a };
      studio?.wave();
    }
  } finally {
    designing.value = false;
  }
}
function save() {
  for (const w of ['you', 'her'] as const) if (JSON.stringify(draft.value[w]) !== JSON.stringify(w === 'you' ? props.you : props.her)) emit('save', w, draft.value[w]);
  show.value = false;
  showToast('存好了');
}
</script>

<template>
  <van-popup v-model:show="show" position="bottom" round teleport="body" class="avatar-pop" :style="{ height: '92%' }" :close-on-popstate="true">
    <div class="editor" data-sheet="avatar">
      <header class="head">
        <button type="button" class="icon-btn" aria-label="不存了" @click="show = false"><span class="i-lucide-x text-[20px]" /></button>
        <div class="flex-1 min-w-0"><Segmented v-model="who" :options="whoOptions" /></div>
        <button type="button" class="save press" @click="save">好了</button>
      </header>

      <div class="stage">
        <canvas ref="canvas" class="block w-full h-full" aria-label="小人预览，拖着可以转" />
        <div class="stage-btns">
          <button type="button" class="pill" @click="shuffle"><span class="i-lucide-shuffle" />随机</button>
          <button type="button" class="pill" :disabled="designing" @click="letHerDesign">
            <span :class="designing ? 'i-lucide-loader-circle spin' : 'i-lucide-wand-sparkles'" />{{ designing ? `${herPronoun}在捏…` : who === 'her' ? `让${herPronoun}给自己捏` : `让${herPronoun}帮你捏` }}
          </button>
        </div>
      </div>

      <Segmented v-model="group" :options="GROUPS" class="mt-2" />
      <div class="fields">
        <div v-for="f in fields" :key="f.key" class="field">
          <div class="label">{{ f.label }}</div>
          <div v-if="f.options" class="chips">
            <button v-if="f.multi" type="button" class="chip-btn" :class="{ on: !(current[f.key] as string[]).length }" :aria-pressed="!(current[f.key] as string[]).length" @click="set(f.key, [] as never)">不戴</button>
            <button
              v-for="o in f.options"
              :key="o.id"
              type="button"
              class="chip-btn"
              :class="{ on: picked(f.key, o.id, f.multi) }"
              :aria-pressed="picked(f.key, o.id, f.multi)"
              @click="f.multi ? toggleIn(f.key, o.id) : set(f.key, o.id as never)"
            >
              {{ o.name }}
            </button>
          </div>
          <div v-else-if="f.toggle" class="chips">
            <button type="button" class="chip-btn" :class="{ on: !!current[f.key] }" :aria-pressed="!!current[f.key]" @click="set(f.key, true as never)">{{ f.toggle[0] }}</button>
            <button type="button" class="chip-btn" :class="{ on: !current[f.key] }" :aria-pressed="!current[f.key]" @click="set(f.key, false as never)">{{ f.toggle[1] }}</button>
          </div>
          <div v-else class="chips">
            <button v-if="f.none" type="button" class="chip-btn" :class="{ on: !current[f.key] }" :aria-pressed="!current[f.key]" @click="set(f.key, '' as never)">{{ f.none }}</button>
            <button
              v-for="c in f.colors"
              :key="c.hex"
              type="button"
              class="swatch"
              :class="{ on: String(current[f.key]).toLowerCase() === c.hex }"
              :style="{ background: c.hex }"
              :aria-label="c.name"
              :title="c.name"
              @click="set(f.key, c.hex as never)"
            />
            <label class="swatch custom" :aria-label="`${f.label}：自己调`">
              <input type="color" :value="current[f.key] || f.colors?.[0]?.hex" @input="set(f.key, ($event.target as HTMLInputElement).value as never)" /><span class="i-lucide-plus" />
            </label>
          </div>
        </div>
        <template v-if="group === 'more'">
          <div class="field">
            <div class="label">头的大小 {{ Math.round(current.head * 100) }}%</div>
            <input type="range" min="0.85" max="1.15" step="0.01" :value="current.head" class="slider" aria-label="头的大小" @input="set('head', Number(($event.target as HTMLInputElement).value))" />
          </div>
          <div class="field">
            <div class="label">身高 {{ Math.round(current.height * 100) }}%</div>
            <input type="range" min="0.85" max="1.15" step="0.01" :value="current.height" class="slider" aria-label="身高" @input="set('height', Number(($event.target as HTMLInputElement).value))" />
          </div>
        </template>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 10px 14px calc(var(--safe-bottom) + 12px);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.save {
  height: 34px;
  padding: 0 16px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 600;
}
.stage {
  position: relative;
  flex: 0 0 38%;
  min-height: 200px;
  margin-top: 8px;
  border-radius: 20px;
  overflow: hidden;
  background: radial-gradient(80% 70% at 50% 40%, var(--accent-soft), var(--panel));
  touch-action: none;
}
.stage-btns {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  font-size: 13px;
  color: var(--ink);
}
.pill:disabled {
  opacity: 0.8;
}
.fields {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 2px 8px;
}
.field {
  margin-top: 12px;
}
.label {
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.chip-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.chip-btn.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.swatch {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--border);
}
.swatch.on {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.swatch.custom {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: conic-gradient(#f4b6c2, #f6e09a, #b5dfc9, #a9c4e0, #c9b8e8, #f4b6c2);
  color: #fff;
}
.swatch.custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.slider {
  width: 100%;
  accent-color: var(--accent);
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
