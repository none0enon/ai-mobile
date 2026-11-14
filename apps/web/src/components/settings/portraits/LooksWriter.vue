<script setup lang="ts">
import { errorReport, errorText, type SpriteLooks } from '@app/ai';
import { imageAppearance, type Character } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import { applyLooks, spriteStatus, writeLooks } from '@/services/sprites';

/**
 * 让 AI 写外观 tags（立绘预设的 sprite-tags 任务，"生图提示词"的 API）：从角色卡、世界书里找出她的长相，
 * 顺带一套常穿的衣服。先给你看、能改，"就用这个"才存（立绘页的 AI 画立绘、角色设定 → 生图 都用它）。
 */
const props = defineProps<{ character: Character }>();
const emit = defineEmits<{ (e: 'applied', outfitName: string | null): void }>();
const has = computed(() => !!imageAppearance(props.character));
const status = computed(() => spriteStatus(props.character));
const looks = ref<(SpriteLooks & { model: string }) | null>(null);
const busy = ref(false);
const error = ref<{ reason: string; detail: string } | null>(null);

async function ask() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const r = await writeLooks(props.character);
    looks.value = { ...r.value, outfit: r.value.outfit ? { ...r.value.outfit } : null, model: r.model };
  } catch (e) {
    error.value = { reason: errorText(e), detail: errorReport(e) };
  } finally {
    busy.value = false;
  }
}
function use() {
  if (!looks.value) return;
  applyLooks(props.character, looks.value);
  const name = looks.value.outfit?.name ?? null;
  looks.value = null;
  showToast('外观 tags 存好了');
  emit('applied', name);
}
</script>

<template>
  <div class="lw">
    <div v-if="!looks" class="lw-actions">
      <van-button size="small" round :type="has ? 'default' : 'primary'" :loading="busy" loading-text="在写…" data-testid="sprite-looks" @click="ask">
        {{ has ? '让 AI 重写外观 tags' : '让 AI 写外观 tags' }}
      </van-button>
      <slot />
    </div>
    <p v-if="!status.promptLive && !looks" class="lw-note">
      写 tags 用「生图提示词」的 API（{{ status.promptReason }}）。<RouterLink to="/me/api?feature=imagePrompt" class="text-accent-ink">去设置</RouterLink>
    </p>
    <ErrorDetails v-if="error" :title="error.reason" :detail="error.detail" max-height="30vh" />
    <div v-if="looks" class="lw-card" data-testid="sprite-looks-preview">
      <label class="field-label" for="lw-app">外观 tags</label>
      <textarea id="lw-app" v-model="looks.appearance" class="textarea mono" rows="3" spellcheck="false" />
      <label class="field-label" for="lw-neg">负面 tags</label>
      <textarea id="lw-neg" v-model="looks.negative" class="textarea mono" rows="2" spellcheck="false" />
      <template v-if="looks.outfit">
        <label class="field-label" for="lw-outfit">常穿的一套（画立绘默认穿它，记成立绘的一套服装）</label>
        <input id="lw-outfit" v-model="looks.outfit.name" class="input" maxlength="16" />
        <textarea v-model="looks.outfit.tags" class="textarea mono mt-1.5" rows="2" spellcheck="false" aria-label="这套衣服的 tags" />
      </template>
      <div class="text-[12px] text-ink-3 mt-1.5">{{ looks.model }} 写的，按立绘预设「{{ status.preset?.name }}」</div>
      <div class="flex gap-2 mt-2.5">
        <van-button round block size="small" :loading="busy" @click="ask">再写一次</van-button>
        <van-button round block size="small" type="primary" data-testid="sprite-looks-use" @click="use">就用这个</van-button>
      </div>
      <button type="button" class="lw-skip" @click="looks = null">先不用</button>
    </div>
  </div>
</template>

<style scoped>
.lw-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}
.lw-note {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.lw-card {
  margin-top: 10px;
  padding: 10px;
  border-radius: 14px;
  background: var(--panel);
}
.lw-skip {
  display: block;
  width: 100%;
  margin-top: 6px;
  font-size: 13px;
  color: var(--ink-3);
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
</style>
