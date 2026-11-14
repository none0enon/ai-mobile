<script setup lang="ts">
import { nextTick, ref } from 'vue';

/**
 * 选一个标签（表情 / 动作 / 服装）：一排可点的小块，最后一块"＋"就地起个新名字。
 * dim 的是"还没有图"的（例如没有图的基础表情），照样能选。
 */
const props = defineProps<{
  options: { id: string; label: string; dim?: boolean }[];
  /** 有这一项时最前面多一块"不分"（值是空字符串） */
  noneLabel?: string;
  addLabel?: string;
  name: string;
}>();
const model = defineModel<string>({ required: true });
const emit = defineEmits<{ (e: 'add', label: string): void }>();

const adding = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);
async function startAdd() {
  adding.value = true;
  draft.value = '';
  await nextTick();
  input.value?.focus();
}
function confirm() {
  // 回车提交后输入框卸掉还会再触发一次 blur
  if (!adding.value) return;
  const v = draft.value.trim();
  adding.value = false;
  if (v) emit('add', v);
}
</script>

<template>
  <div class="label-picker" role="radiogroup" :aria-label="props.name">
    <button v-if="noneLabel !== undefined" type="button" class="lp" :class="{ on: model === '' }" role="radio" :aria-checked="model === ''" @click="model = ''">{{ noneLabel }}</button>
    <button
      v-for="o in options"
      :key="o.id"
      type="button"
      class="lp"
      :class="{ on: model === o.id, dim: o.dim }"
      role="radio"
      :aria-checked="model === o.id"
      @click="model = o.id"
    >
      {{ o.label }}
    </button>
    <form v-if="adding" class="lp-add" @submit.prevent="confirm">
      <input ref="input" v-model="draft" class="lp-input" :placeholder="`新${name}的名字`" maxlength="16" enterkeyhint="done" @blur="confirm" />
    </form>
    <button v-else-if="addLabel" type="button" class="lp add" @click="startAdd"><span class="i-lucide-plus" />{{ addLabel }}</button>
  </div>
</template>

<style scoped>
.label-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.lp {
  height: 30px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.lp.dim {
  opacity: 0.55;
}
.lp.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
  opacity: 1;
}
.lp.add {
  color: var(--accent-ink);
  background: var(--accent-soft);
}
.lp-input {
  height: 30px;
  width: 9em;
  padding: 0 10px;
  border-radius: 99px;
  border: 1px solid var(--accent);
  background: var(--surface);
  font-size: 13px;
  outline: none;
}
</style>
