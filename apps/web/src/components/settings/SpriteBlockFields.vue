<script setup lang="ts">
import { NOVELAI_EMOTIONS } from '@app/ai';
import {
  blockLevel,
  POSES,
  SPRITE_BLOCK_KINDS,
  SPRITE_DRAW,
  SPRITE_EXPR,
  SPRITE_NEGATIVE,
  SPRITE_POSE,
  SPRITE_TASKS,
  spriteBlockKind,
  spriteBlockMeta,
  type Pose,
  type PromptBlock,
  type SpriteBlockKind,
} from '@app/shared';
import { computed } from 'vue';

/**
 * 立绘预设里一块是什么（预设编辑页的块编辑器里用）：
 * 交给文本模型的任务（写外观 tags、给新表情写 tags）/ 画法 / 负面 / 一个表情 / 一个动作。
 * 表情、动作的名字写进触发条件（sprite-expr:名字），画出来的立绘就标成这个名字；块上还能选换表情用的情绪、写说明、动作适合的场景。
 */
const props = defineProps<{ block: PromptBlock }>();
const DRAW_MACROS = '{{char_appearance}}（长相）、{{char_outfit}}（这身衣服的 tags）、{{expression}}（表情的 tags）、{{pose}}（动作的 tags）';
const emit = defineEmits<{ (e: 'touch'): void }>();

const kind = computed(() => spriteBlockKind(props.block));
const meta = computed(() => spriteBlockMeta(props.block));
const prefix = computed(() => (kind.value === 'expression' ? SPRITE_EXPR : SPRITE_POSE));
const label = computed(() => blockLevel(props.block, prefix.value));

/** 块名里"表情 · 平静"的后半截，换成表情 / 动作时当默认名字 */
function nameFromBlock(): string {
  return props.block.name.split(/[·:：]/).pop()?.trim() || props.block.name.trim() || '新的';
}

function setKind(k: SpriteBlockKind) {
  const b = props.block;
  if (k === kind.value) return;
  const name = label.value || nameFromBlock();
  b.triggers = { task: undefined, draw: [SPRITE_DRAW], negative: [SPRITE_NEGATIVE], expression: [`${SPRITE_EXPR}${name}`], pose: [`${SPRITE_POSE}${name}`] }[k];
  emit('touch');
}
function setName(v: string) {
  const name = v.trim();
  if (!name) return;
  props.block.triggers = [...(props.block.triggers ?? []).filter((t) => !t.startsWith(prefix.value)), `${prefix.value}${name}`];
  emit('touch');
}
function toggleTask(t: string) {
  const set = new Set(props.block.triggers ?? []);
  if (set.has(t)) set.delete(t);
  else set.add(t);
  props.block.triggers = set.size ? [...set] : undefined;
  emit('touch');
}
function setMeta(patch: Record<string, unknown>) {
  const next: Record<string, unknown> = { ...props.block.extra, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) delete next[k];
  props.block.extra = Object.keys(next).length ? next : undefined;
  emit('touch');
}
function toggleFit(f: Pose) {
  const fits = new Set(meta.value.fits ?? []);
  if (fits.has(f)) fits.delete(f);
  else fits.add(f);
  setMeta({ fits: (Object.keys(POSES) as Pose[]).filter((k) => fits.has(k)) });
}
</script>

<template>
  <div class="field-label">这一块是什么</div>
  <div class="flex flex-wrap gap-1.5">
    <button v-for="(text, k) in SPRITE_BLOCK_KINDS" :key="k" type="button" class="opt" :class="{ on: kind === k }" @click="setKind(k)">{{ text }}</button>
  </div>
  <p class="sbf-note">
    <template v-if="kind === 'task'">交给"生图提示词"的文本模型；只在做下面选中的事时发送（都不选 = 两件事都发）。</template>
    <template v-else-if="kind === 'draw'">NovelAI 的正向提示词模板，不发给文本模型。能用 {{ DRAW_MACROS }}。</template>
    <template v-else-if="kind === 'negative'">NovelAI 的负面提示词，不发给文本模型；角色自己的负面 tags 会接在后面。</template>
    <template v-else-if="kind === 'expression'">内容写这个表情的 NovelAI tags（只写脸上的）。画出来的立绘标成下面这个名字，模型写 [expr:名字] 时换成它。</template>
    <template v-else>内容写这个动作的 NovelAI tags（只写姿势和手）。画出来的立绘标成下面这个名字。</template>
  </p>

  <template v-if="kind === 'task'">
    <div class="flex flex-wrap gap-1.5 mt-2">
      <button v-for="(text, t) in SPRITE_TASKS" :key="t" type="button" class="opt" :class="{ on: block.triggers?.includes(t) }" @click="toggleTask(t)">{{ text }}</button>
    </div>
  </template>

  <template v-else-if="kind === 'expression' || kind === 'pose'">
    <label class="field-label" for="sbf-name">{{ kind === 'expression' ? '表情' : '动作' }}的名字</label>
    <input id="sbf-name" :value="label" class="input" autocomplete="off" maxlength="16" @change="setName(($event.target as HTMLInputElement).value)" />
    <label class="field-label" for="sbf-hint">什么时候用（写给聊天的模型看，可以不写）</label>
    <input id="sbf-hint" :value="meta.hint ?? ''" class="input" autocomplete="off" maxlength="40" @change="setMeta({ hint: ($event.target as HTMLInputElement).value.trim() })" />
    <template v-if="kind === 'expression'">
      <label class="field-label" for="sbf-emotion">用 Director Tools 换表情时选哪种情绪</label>
      <select id="sbf-emotion" class="input" :value="meta.emotion ?? ''" @change="setMeta({ emotion: ($event.target as HTMLSelectElement).value })">
        <option value="">不用（只重画脸）</option>
        <option v-for="e in NOVELAI_EMOTIONS" :key="e" :value="e">{{ e }}</option>
      </select>
    </template>
    <template v-else>
      <div class="field-label">适合哪些场景（都不选 = 哪儿都能用）</div>
      <div class="flex flex-wrap gap-1.5">
        <button v-for="(text, f) in POSES" :key="f" type="button" class="opt" :class="{ on: meta.fits?.includes(f) }" @click="toggleFit(f)">{{ text }}</button>
      </div>
    </template>
  </template>
</template>

<style scoped>
.sbf-note {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.opt {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
</style>
