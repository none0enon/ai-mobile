<script setup lang="ts">
import { showToast } from 'vant';
import { nextTick, ref } from 'vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { commitImport, defaultPresetId, readImport, type ImportDone, type PendingImport } from '@/services/importer';
import { useLibraryStore } from '@/stores/library';

/**
 * 导入 SillyTavern 文件。选了文件先显示识别结果，确认后才真正导入。
 * PNG 读 tEXt 块（优先 ccv3，其次 chara），JSON 按内容判断是角色卡、世界书还是预设。
 * 导入的东西存在本机（IndexedDB），刷新后还在。
 */
const KINDS = [
  { id: 'card', icon: 'i-lucide-contact-round', title: '角色卡', accept: '.png,.json,image/png,application/json', hint: '.png .json', desc: 'V1 / V2 / V3（PNG 或 JSON）。内嵌的世界书会拆出来自动绑定，备选开场白、标签、扩展字段都保留。' },
  { id: 'lore', icon: 'i-lucide-library-big', title: '世界书', accept: '.json,application/json', hint: '.json', desc: 'World Info JSON：关键词、次关键词逻辑、常驻、插入位置 / 深度、顺序、概率、分组、递归、粘性 / 冷却 / 延迟。' },
  { id: 'preset', icon: 'i-lucide-sliders-horizontal', title: '预设', accept: '.json,application/json', hint: '.json', desc: 'Chat Completion 预设：提示词块与顺序（用 ST 实际生效的那套）、采样参数、拼装用的文字。App 自己的记忆 / 环境 / 场景块会自动补进去。' },
  { id: 'chat', icon: 'i-lucide-messages-square', title: '聊天记录', accept: '.jsonl', hint: '.jsonl', desc: 'SillyTavern 的 .jsonl 聊天记录，含 swipe。（下一步做）' },
];

const lib = useLibraryStore();
const pending = ref<PendingImport | null>(null);
const done = ref<ImportDone | null>(null);
const error = ref('');
const busy = ref(false);
const presetId = ref<string | null>(null);
const resultEl = ref<HTMLElement | null>(null);

/** 结果卡片在四个入口下面，手机上一屏放不下：出来以后滚过去 */
async function reveal() {
  await nextTick();
  resultEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function picked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  done.value = null;
  error.value = '';
  pending.value = null;
  try {
    pending.value = await readImport(file);
    presetId.value = defaultPresetId();
  } catch (err) {
    error.value = `${file.name}：${err instanceof Error ? err.message : String(err)}`;
  }
  void reveal();
}

async function confirm() {
  if (!pending.value || busy.value) return;
  busy.value = true;
  try {
    done.value = await commitImport(pending.value, { presetId: presetId.value });
    pending.value = null;
    void reveal();
  } catch (err) {
    showToast(`导入失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    busy.value = false;
  }
}

const TITLE: Record<PendingImport['kind'], string> = { card: '角色卡', preset: '预设', lorebook: '世界书' };
</script>

<template>
  <div class="page" data-page="import">
    <PageHeader title="导入" subtitle="SillyTavern 的角色卡、世界书、预设、聊天记录" fallback="/me" />
    <div class="page-scroll px-4 py-3 grid gap-3 content-start">
      <label v-for="k in KINDS" :key="k.id" class="drop press" :data-kind="k.id">
        <span class="drop-icon"><span :class="k.icon" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[15.5px] font-600">{{ k.title }} <span class="text-[12px] text-ink-3 font-400">{{ k.hint }}</span></div>
          <div class="text-[12.5px] text-ink-2 leading-relaxed mt-0.5">{{ k.desc }}</div>
        </div>
        <input type="file" :accept="k.accept" class="sr-only" :aria-label="`选择${k.title}文件`" @change="picked" />
        <span class="pick-btn">选择</span>
      </label>

      <div ref="resultEl" class="scroll-anchor" />
      <div v-if="error" class="result err" role="alert">
        <div class="flex items-center gap-2 text-[14px] font-600"><span class="i-lucide-circle-alert" />读不出来</div>
        <p class="text-[13px] text-ink-2 mt-1.5 mb-0 break-all">{{ error }}</p>
      </div>

      <div v-if="pending" class="result" data-testid="import-result">
        <div class="flex items-center gap-2 text-[14px] font-600">
          <span class="i-lucide-scan-search text-accent-ink" />识别结果 · {{ TITLE[pending.kind] }}
          <span class="ml-auto text-[11.5px] text-ink-3 font-400 truncate max-w-[45%]">{{ pending.fileName }}</span>
        </div>
        <ul class="mt-2 mb-0 pl-5 text-[13.5px] text-ink-2 leading-relaxed">
          <li v-for="l in pending.lines" :key="l">{{ l }}</li>
        </ul>
        <ul v-if="pending.warnings.length" class="warn mt-2 mb-0 pl-5 text-[13px] leading-relaxed">
          <li v-for="w in pending.warnings" :key="w">{{ w }}</li>
        </ul>
        <template v-if="pending.kind === 'card'">
          <div class="text-[12.5px] text-ink-3 mt-3 mb-1.5">聊天用哪个预设（之后在聊天里也能换）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="p in lib.presets" :key="p.id" type="button" class="chip-btn" :class="{ on: presetId === p.id }" @click="presetId = p.id">
              {{ p.name }}
            </button>
          </div>
          <p class="text-[12px] text-ink-3 mt-2.5 mb-0 leading-relaxed">导入的角色暂时没有自己的小世界（地图上不出现），从角色卡生成小世界是下一步。</p>
        </template>
        <van-button type="primary" round block class="!mt-3" :loading="busy" @click="confirm">导入</van-button>
      </div>

      <div v-if="done" class="result ok" data-testid="import-done">
        <div class="flex items-center gap-2 text-[14px] font-600"><span class="i-lucide-circle-check text-accent-ink" />{{ done.message }}</div>
        <div class="flex flex-wrap gap-2 mt-3">
          <RouterLink v-for="l in done.links" :key="l.to" :to="l.to" class="link-btn">{{ l.label }}</RouterLink>
        </div>
      </div>

      <p class="text-[12px] text-ink-3 leading-relaxed m-0">
        导入的角色卡、世界书、预设和聊天存在这台设备上，刷新后还在。导出成 SillyTavern 能读的文件（PNG 里同时写 chara 和 ccv3）已经能做，按钮下一步加。
      </p>
    </div>
  </div>
</template>

<style scoped>
.drop {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1.5px dashed var(--border);
  cursor: pointer;
}
.drop-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 20px;
  flex-shrink: 0;
}
.pick-btn {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 13px;
  flex-shrink: 0;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.scroll-anchor {
  height: 0;
  margin-top: -12px;
  scroll-margin-top: 8px;
}
.result {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--accent-line);
}
.result.err {
  border-color: var(--border);
  color: var(--ink);
}
.warn {
  color: var(--ink-2);
  background: var(--panel);
  border-radius: 12px;
  padding-top: 6px;
  padding-bottom: 6px;
}
.chip-btn {
  height: 30px;
  max-width: 100%;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  border: 1px solid transparent;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-btn.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 600;
}
.link-btn {
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding: 0 14px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13.5px;
  text-decoration: none;
}
.link-btn:first-child {
  background: var(--accent);
  color: var(--on-accent, #2b1219);
  font-weight: 600;
}
</style>
