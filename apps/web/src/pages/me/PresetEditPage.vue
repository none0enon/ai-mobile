<script setup lang="ts">
import {
  IMAGE_MODES,
  IMAGE_MOMENTS,
  isRoleplayCategory,
  markerName,
  momentLabel,
  PRESET_CATEGORIES,
  RHYTHM_TASKS,
  ROLEPLAY_CATEGORIES,
  SCENES,
  type PresetCategory,
  type PromptBlock,
} from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, ref, toRaw, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import { useDragSort } from '@/composables/useDragSort';
import PageHeader from '@/layouts/PageHeader.vue';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';

/**
 * 编辑一个预设（自带的和导入的一样）：
 * - 提示词：每一块的名字、内容、角色、位置都能改，能加块、删块、开关；长按一块拖动调顺序（电脑上按住直接拖）；程序填充的块内容由程序填，其余都能改；
 * - 采样参数、正则；名字、说明、分类（对话 / 功能 / 主动消息之间可以互换）；
 * - 右上角 ⋯：复制一份、导出成预设文件、恢复成预设文件里的样子（自带的）、删除。
 * 改了马上存在本机，下一次调用起生效。
 */
const route = useRoute();
const router = useRouter();
const lib = useLibraryStore();
const chars = useCharacterStore();
const preset = computed(() => lib.presetById(route.params.id as string));
const tab = ref<'blocks' | 'sampler' | 'regex' | 'info'>('blocks');
const ROLE: Record<PromptBlock['role'], string> = { system: '系统', user: '用户', assistant: '助手' };
const roleplay = computed(() => !!preset.value && isRoleplayCategory(preset.value.category));
const usedBy = computed(() => {
  const p = preset.value;
  if (!p) return '';
  if (p.category === 'chat') return chars.list.filter((c) => lib.chatPresetFor(c)?.id === p.id).map((c) => c.name).join('、');
  return lib.usesOf(p.id).map((u) => u.label).join('、');
});
const hasSeed = computed(() => !!preset.value && !!lib.seedOf(preset.value.id));

function touch() {
  if (preset.value) preset.value.updatedAt = Date.now();
}

function where(b: PromptBlock): string {
  if (!roleplay.value || b.injection.position !== 'absolute') return '按顺序';
  return b.injection.depth === 0 ? '插在聊天记录最后' : `插在聊天记录倒数第 ${b.injection.depth} 条前`;
}
function line(b: PromptBlock): string {
  if (b.marker) return `程序填充：${markerName(b.identifier) ?? b.name}`;
  return b.content.replace(/\s+/g, ' ').trim() || '（空）';
}

// —— 一块一块地改 ——
const editing = ref<PromptBlock | null>(null);
const editOpen = computed({ get: () => !!editing.value, set: (v) => !v && (editing.value = null) });
// 直接换到另一个预设（同一个页面换参数）：正在改的那一块属于上一个预设，关掉
watch(
  () => route.params.id,
  () => (editing.value = null),
);

// —— 调顺序：长按一块拖到想要的位置（电脑上按住直接拖，手柄上也能用 ↑ ↓）——
function moveBlock(from: number, to: number) {
  const bs = preset.value?.blocks;
  if (!bs || from === to || !bs[from] || to < 0 || to >= bs.length) return;
  const [b] = bs.splice(from, 1);
  if (b) bs.splice(to, 0, b);
  touch();
}
const listEl = ref<HTMLElement | null>(null);
const tabsEl = ref<ComponentPublicInstance | null>(null);
const sort = useDragSort({
  list: listEl,
  onMove: moveBlock,
  // 吸顶的标签栏下面才是看得见的列表：拖到标签栏下沿就开始往上滚
  visibleTop: () => (tabsEl.value?.$el as HTMLElement | undefined)?.getBoundingClientRect().bottom ?? 0,
});
/** 每一块一个固定的 key（同一个预设里 identifier 可能重复），挪位置时 DOM 跟着这一块走 */
const blockKeys = new WeakMap<PromptBlock, string>();
let keySeq = 0;
function keyOf(b: PromptBlock): string {
  const raw = toRaw(b);
  let k = blockKeys.get(raw);
  if (!k) {
    keySeq += 1;
    k = `block-${keySeq}`;
    blockKeys.set(raw, k);
  }
  return k;
}
function addBlock() {
  const bs = preset.value?.blocks;
  if (!bs) return;
  bs.push({ identifier: `custom-${Date.now().toString(36)}`, name: '新的一块', role: 'system', content: '', marker: false, enabled: true, injection: { position: 'relative', depth: 4 } });
  touch();
  editing.value = bs.at(-1) ?? null;
}
async function removeBlock(b: PromptBlock) {
  const p = preset.value;
  if (!p) return;
  const ok = await showConfirmDialog({
    title: `删掉"${b.name}"？`,
    message: b.marker ? '这是程序填充的块，删了以后这部分内容不会再发给模型。' : '这一块的文字会一起删掉。',
    confirmButtonText: '删掉',
    confirmButtonColor: 'var(--bad)',
  }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  p.blocks = p.blocks.filter((x) => x !== b);
  editing.value = null;
  touch();
}
function setPosition(b: PromptBlock, absolute: boolean) {
  b.injection = { ...b.injection, position: absolute ? 'absolute' : 'relative' };
  touch();
}
/** 触发条件的中文名：画什么、场景里的时刻、节律的任务；别的（一起做事的场景任务名）原样显示 */
function triggerLabel(t: string): string {
  return IMAGE_MODES[t as keyof typeof IMAGE_MODES] ?? momentLabel(t) ?? RHYTHM_TASKS[t as keyof typeof RHYTHM_TASKS] ?? t;
}
/** 生图预设里能选的时刻：按场景分组（只列有时刻的场景） */
const momentGroups = computed(() =>
  SCENES.filter((sc) => IMAGE_MOMENTS[sc.id as keyof typeof IMAGE_MOMENTS]).map((sc) => ({ scene: sc.name, moments: IMAGE_MOMENTS[sc.id as keyof typeof IMAGE_MOMENTS] ?? {} })),
);
function toggleTrigger(b: PromptBlock, mode: string) {
  const t = new Set(b.triggers ?? []);
  if (t.has(mode)) t.delete(mode);
  else t.add(mode);
  b.triggers = t.size ? [...t] : undefined;
  touch();
}

// —— 名字、分类 ——
function setCategory(c: PresetCategory) {
  const p = preset.value;
  if (!p || p.category === c) return;
  p.category = c;
  touch();
  showToast(`改成${PRESET_CATEGORIES[c].label}预设了；原来用它的地方会改用那一类的第一个`);
}

// —— 右上角 ⋯ ——
const moreOpen = ref(false);
const actions = computed(() => [
  { name: '复制一份', subname: roleplay.value ? '可以复制成对话、功能或主动消息预设' : '复制以后可以放心改', key: 'copy' },
  { name: '导出预设文件', subname: '.json，能在别的设备上导入，也能放进 src/presets 当自带预设', key: 'export' },
  ...(hasSeed.value ? [{ name: '恢复成预设文件里的样子', subname: preset.value?.seedFile ?? '', key: 'restore' }] : []),
  { name: '删除这个预设', color: 'var(--bad)', key: 'delete' },
]);
const copyOpen = ref(false);
function onAction(a: { key: string }) {
  moreOpen.value = false;
  if (a.key === 'copy') {
    if (roleplay.value) copyOpen.value = true;
    else copyAs();
  } else if (a.key === 'export') exportFile();
  else if (a.key === 'restore') void restore();
  else if (a.key === 'delete') void remove();
}
function copyAs(c?: PresetCategory) {
  copyOpen.value = false;
  const p = preset.value;
  if (!p) return;
  const copy = lib.duplicatePreset(p.id, c);
  if (!copy) return;
  showToast(`复制好了：${PRESET_CATEGORIES[copy.category].label}预设「${copy.name}」`);
  void router.replace(`/me/presets/${copy.id}`);
}
function exportFile() {
  const p = preset.value;
  const file = p && lib.exportFile(p.id);
  if (!p || !file) return;
  const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
async function restore() {
  const p = preset.value;
  if (!p) return;
  const ok = await showConfirmDialog({ title: '恢复成预设文件里的样子？', message: `按 ${p.seedFile} 重新来一遍：你在这个预设里改过的块、参数、名字都会还原。`, confirmButtonText: '恢复' }).then(
    () => true,
    () => false,
  );
  if (ok && lib.restoreFromFile(p.id)) showToast('恢复好了');
}
async function remove() {
  const p = preset.value;
  if (!p) return;
  const ok = await showConfirmDialog({
    title: `删除「${p.name}」？`,
    message: `${usedBy.value ? `现在用在：${usedBy.value}，删了以后那些地方改用这一类的第一个预设。` : ''}${p.seedFile ? `这是自带的预设，删了不会自己回来；想要可以重新导入 ${p.seedFile}。` : ''}`,
    confirmButtonText: '删除',
    confirmButtonColor: 'var(--bad)',
  }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  const cat = p.category;
  lib.removePreset(p.id);
  showToast('删掉了');
  void router.replace(`/me/presets?cat=${cat}`);
}

const MACROS = '{{char}}、{{user}}、{{time}}';
const HINT: Record<PresetCategory, string> = {
  chat: '"程序填充"的块由 App 生成：角色卡字段、命中的世界书、记忆、【当前环境】、场景规则、聊天记录。导入 ST 预设时，这几块会自动插进它的顺序里。',
  feature: '一起做某件事时用。"场景规则"那一块写这件事里她怎么说话，可以改；能用的标签和表情由程序按场景填。',
  proactive: '"主动消息：这一次要她做的事"由程序填（现在几点、这次为什么来找你），插在聊天记录最后；怎么写（长短、口吻）写在别的块里。',
  theater: '"程序填充"的块是这一次的输入（角色、她的世界、现在、记得的事、最近的聊天）；任务、要求、输出格式都能改。输出格式里的字段名别改，程序按它读。',
  summary: '"程序填充"的块是这一次的输入（现在、上一段摘要、已有记忆、要整理的聊天）；任务、规则、输出格式都能改。输出格式里的字段名别改，程序按它读。',
  image:
    '"画什么"几块按这次画的类型只发一块，一起做事时自动画的"时刻"（入座、偷拍、奖励……）也一样（在块里设"只在画这些时发送"）；"程序填充"的块是这一次的输入。块里能用 {{char_appearance}}（她的长相，同人是角色 tag + 作品 tag）、{{char_outfit}}（节律里她今天这个场景穿的那套）、{{user_appearance}}。输出格式里的字段名别改，程序按它读。',
  rhythm:
    '"建世界""排今天"两件任务、穿着的两种做法按触发条件只发这次要做的那几块（在块里设"只在做这些事时发送"）；"程序填充"的块是这一次的输入（角色、世界书、她的世界、模板、衣柜、今天、最近几天）。输出格式里的字段名别改，程序按它读，读完还会检查作息有没有盖满一天、地点在不在她的世界里。',
};
</script>

<template>
  <div v-if="preset" class="page" data-page="preset-edit">
    <PageHeader :title="preset.name" :subtitle="`${PRESET_CATEGORIES[preset.category].label}预设${usedBy ? ` · 用在：${usedBy}` : ''}`" :fallback="`/me/presets?cat=${preset.category}`">
      <template #right>
        <button class="icon-btn" aria-label="更多" @click="moreOpen = true"><span class="i-lucide-ellipsis text-[20px]" /></button>
      </template>
    </PageHeader>
    <div class="page-scroll pb-10">
      <Segmented
        ref="tabsEl"
        v-model="tab"
        sticky
        :options="[
          { value: 'blocks', label: '提示词' },
          { value: 'sampler', label: '采样参数' },
          { value: 'regex', label: '正则' },
          { value: 'info', label: '名字分类' },
        ]"
      />

      <div v-if="tab === 'blocks'" ref="listEl" class="px-4 grid gap-1.5" data-testid="preset-blocks">
        <div
          v-for="(b, i) in preset.blocks"
          :key="keyOf(b)"
          class="block sortable"
          :class="{ off: !b.enabled, lifted: sort.state.phase === 'drag' && sort.state.from === i }"
          :style="sort.styleFor(i)"
          :data-block="b.identifier"
          data-sort-item
          @pointerdown="sort.onPointerDown($event, i)"
          @touchstart.passive="sort.onTouchStart($event, i)"
        >
          <button type="button" class="grip" data-sort-handle :aria-label="`拖动调整「${b.name}」的位置，也可以按上下方向键`" @keydown="sort.onHandleKey($event, i)">
            <span class="i-lucide-grip-vertical" />
          </button>
          <button type="button" class="flex-1 min-w-0 text-left" :aria-label="`编辑「${b.name}」`" @click="editing = b">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="block-name text-[14px] truncate" :class="{ 'font-600': !b.marker }">{{ b.name }}</span>
              <!-- 窄屏、大字体时标签先让位，名字尽量完整 -->
              <span class="block-tags">
                <span class="tag">{{ ROLE[b.role] }}</span>
                <span v-if="b.marker" class="tag accent">程序填充</span>
                <span v-if="b.triggers?.length" class="tag">只在 {{ b.triggers.map(triggerLabel).join(' / ') }}</span>
              </span>
            </div>
            <div class="text-[11.5px] text-ink-3 truncate">{{ where(b) }} · {{ line(b) }}</div>
          </button>
          <van-switch v-model="b.enabled" data-sort-ignore size="20px" :aria-label="`发送「${b.name}」`" @change="touch" />
        </div>
        <button type="button" class="add press" @click="addBlock"><span class="i-lucide-plus" />加一块</button>
        <p class="text-[12px] text-ink-3 mt-1 mb-0 leading-relaxed">
          长按一块拖到想要的位置（电脑上用鼠标按住直接拖），从上到下就是发给模型的顺序。{{ HINT[preset.category] }} 文字里可以用 {{ MACROS }} 这些宏。
        </p>
      </div>

      <van-cell-group v-else-if="tab === 'sampler'" inset>
        <van-cell :title="`温度 ${preset.sampler.temperature.toFixed(2)}`" label="越高越随性">
          <template #label><van-slider v-model="preset.sampler.temperature" :min="0" :max="2" :step="0.05" class="!mt-3" bar-height="4px" button-size="16px" @change="touch" /></template>
        </van-cell>
        <van-cell :title="`Top P ${preset.sampler.topP.toFixed(2)}`">
          <template #label><van-slider v-model="preset.sampler.topP" :min="0" :max="1" :step="0.01" class="!mt-3" bar-height="4px" button-size="16px" @change="touch" /></template>
        </van-cell>
        <van-cell title="回复最长（token）" center>
          <template #right-icon><van-stepper v-model="preset.sampler.maxTokens" min="32" max="16000" step="32" @change="touch" /></template>
        </van-cell>
        <van-cell v-if="roleplay" title="上下文预算（token）" label="聊天记录按它截断" center>
          <template #right-icon><van-stepper v-model="preset.sampler.contextTokens" min="2000" max="200000" step="2000" @change="touch" /></template>
        </van-cell>
        <van-cell :title="`频率惩罚 ${preset.sampler.frequencyPenalty.toFixed(1)}`">
          <template #label><van-slider v-model="preset.sampler.frequencyPenalty" :min="-2" :max="2" :step="0.1" class="!mt-3" bar-height="4px" button-size="16px" @change="touch" /></template>
        </van-cell>
        <van-cell :title="`存在惩罚 ${preset.sampler.presencePenalty.toFixed(1)}`">
          <template #label><van-slider v-model="preset.sampler.presencePenalty" :min="-2" :max="2" :step="0.1" class="!mt-3" bar-height="4px" button-size="16px" @change="touch" /></template>
        </van-cell>
        <van-cell v-if="roleplay" title="流式输出" center>
          <template #right-icon><van-switch v-model="preset.sampler.stream" size="22px" @change="touch" /></template>
        </van-cell>
      </van-cell-group>

      <div v-else-if="tab === 'regex'" class="px-4 grid gap-2">
        <div v-for="r in preset.regex" :key="r.id" class="block">
          <span class="i-lucide-regex text-accent-ink" />
          <div class="flex-1 min-w-0">
            <div class="text-[14px]">{{ r.name }}</div>
            <div class="text-[11.5px] text-ink-3 font-mono truncate">/{{ r.find }}/ → "{{ r.replace }}"</div>
          </div>
          <van-switch v-model="r.enabled" size="20px" @change="touch" />
        </div>
        <p v-if="!preset.regex.length" class="text-[13px] text-ink-3 text-center py-6">这个预设没有正则脚本</p>
      </div>

      <div v-else class="px-4">
        <label class="field-label" for="pe-name">名字</label>
        <input id="pe-name" v-model="preset.name" class="input" autocomplete="off" @change="touch" />
        <label class="field-label" for="pe-desc">说明</label>
        <textarea id="pe-desc" v-model="preset.description" class="textarea" rows="3" @change="touch" />
        <div class="field-label">分类</div>
        <div v-if="roleplay" class="flex flex-wrap gap-1.5">
          <button v-for="c in ROLEPLAY_CATEGORIES" :key="c" type="button" class="opt" :class="{ on: preset.category === c }" @click="setCategory(c)">{{ PRESET_CATEGORIES[c].label }}</button>
        </div>
        <div v-else class="text-[14px]">{{ PRESET_CATEGORIES[preset.category].label }}</div>
        <p class="text-[12px] text-ink-3 mt-1.5 mb-0 leading-relaxed">
          {{ PRESET_CATEGORIES[preset.category].desc }}。{{ roleplay ? '对话、功能、主动消息的程序填充块一样，可以直接改分类。' : '这一类的程序填充块是这件任务专用的，换成别的类要从那一类复制。' }}
        </p>
        <p class="text-[12px] text-ink-3 mt-3 mb-0 leading-relaxed">
          {{ preset.seedFile ? `自带的预设，来自预设文件 ${preset.seedFile}；改了、删了都可以，右上角 ⋯ 能恢复成文件里的样子。` : preset.source?.kind === 'sillytavern' ? `从 SillyTavern 导入（${preset.source.fileName ?? ''}）。` : '你导入或复制的预设。' }}
        </p>
      </div>
    </div>

    <van-action-sheet v-model:show="moreOpen" :actions="actions" cancel-text="取消" close-on-click-action @select="onAction" />
    <van-action-sheet
      v-model:show="copyOpen"
      title="复制成哪一类"
      :actions="ROLEPLAY_CATEGORIES.map((c) => ({ name: `${PRESET_CATEGORIES[c].label}预设`, subname: PRESET_CATEGORIES[c].desc, key: c }))"
      cancel-text="取消"
      close-on-click-action
      @select="(a: { key: PresetCategory }) => copyAs(a.key)"
    />

    <van-popup v-model:show="editOpen" position="bottom" round :style="{ maxHeight: '92%' }">
      <div v-if="editing" class="sheet" data-testid="block-editor">
        <div class="sheet-title">{{ editing.marker ? '程序填充的块' : '编辑这一块' }}</div>
        <label class="field-label" for="be-name">名字</label>
        <input id="be-name" v-model="editing.name" class="input" autocomplete="off" @change="touch" />
        <p v-if="editing.marker" class="text-[12.5px] text-ink-3 mt-2 mb-0 leading-relaxed">
          内容由程序填：{{ markerName(editing.identifier) ?? editing.identifier }}。可以改名字、角色{{ roleplay ? '、位置' : '' }}，或者关掉、删掉。
        </p>
        <template v-else>
          <label class="field-label" for="be-content">内容</label>
          <textarea id="be-content" v-model="editing.content" class="textarea" rows="9" spellcheck="false" @change="touch" />
        </template>
        <div class="field-label">角色</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="(label, r) in ROLE" :key="r" type="button" class="opt" :class="{ on: editing.role === r }" @click="(editing.role = r), touch()">{{ label }}</button>
        </div>
        <template v-if="roleplay">
          <div class="field-label">位置</div>
          <div class="flex flex-wrap items-center gap-1.5">
            <button type="button" class="opt" :class="{ on: editing.injection.position !== 'absolute' }" @click="setPosition(editing, false)">按顺序</button>
            <button type="button" class="opt" :class="{ on: editing.injection.position === 'absolute' }" @click="setPosition(editing, true)">插进聊天记录</button>
            <template v-if="editing.injection.position === 'absolute'">
              <span class="text-[13px] text-ink-2 ml-1">倒数第</span>
              <van-stepper v-model="editing.injection.depth" min="0" max="50" @change="touch" />
              <span class="text-[13px] text-ink-2">条前（0 = 最后）</span>
            </template>
          </div>
        </template>
        <template v-if="preset.category === 'image'">
          <div class="field-label">只在画这些时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, m) in IMAGE_MODES" :key="m" type="button" class="opt" :class="{ on: editing.triggers?.includes(m) }" @click="toggleTrigger(editing, m)">{{ label }}</button>
          </div>
          <template v-for="g in momentGroups" :key="g.scene">
            <div class="text-[12px] text-ink-3 mt-2.5 mb-1.5">{{ g.scene }}时自动画的时刻</div>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(label, m) in g.moments" :key="m" type="button" class="opt" :class="{ on: editing.triggers?.includes(m) }" @click="toggleTrigger(editing, m)">{{ label }}</button>
            </div>
          </template>
        </template>
        <template v-else-if="preset.category === 'rhythm'">
          <div class="field-label">只在做这些事时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, t) in RHYTHM_TASKS" :key="t" type="button" class="opt" :class="{ on: editing.triggers?.includes(t) }" @click="toggleTrigger(editing, t)">{{ label }}</button>
          </div>
        </template>
        <div class="flex gap-2.5 mt-5">
          <van-button round block @click="removeBlock(editing)">删掉这一块</van-button>
          <van-button round block type="primary" @click="editing = null">好了</van-button>
        </div>
      </div>
    </van-popup>
  </div>
  <div v-else class="page items-center justify-center text-ink-3 gap-3" data-page="preset-missing">
    这个预设不在了
    <RouterLink to="/me/presets" class="text-accent-ink">回到预设</RouterLink>
  </div>
</template>

<style scoped>
.block {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 8px 6px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.block.off {
  opacity: 0.55;
}
/* 长按拖动：不选中文字、不弹系统菜单 */
.sortable {
  padding-left: 2px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.sortable.lifted {
  opacity: 1;
  border-color: var(--accent-line);
  box-shadow: var(--shadow);
}
.block-name {
  flex: 0 1 auto;
  min-width: 2.5em;
}
.block-tags {
  display: flex;
  gap: 6px;
  flex: 0 10 auto;
  min-width: 0;
  overflow: hidden;
}
.grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 40px;
  margin-right: -4px;
  border-radius: 10px;
  color: var(--ink-3);
  font-size: 18px;
  /* 按住手柄直接拖，不滚动页面 */
  touch-action: none;
  cursor: grab;
}
@media (hover: hover) {
  .sortable:hover .grip {
    color: var(--ink-2);
  }
}
.add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 42px;
  border-radius: 14px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
  font-size: 13.5px;
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
