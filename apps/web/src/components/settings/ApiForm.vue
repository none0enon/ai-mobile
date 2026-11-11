<script setup lang="ts">
import { CHANNELS, channelsFor, CUSTOM_FORMAT_LABEL, errorReport, errorText, kindOf, listModels, needsKey, newFeatureApi, testConnection, type VoiceSpec } from '@app/ai';
import { AGENT_META, isTextRole, type AgentRole, type ApiChannel, type CustomFormat, type FeatureApi, type PromptProcessing } from '@app/shared';
import { computed, ref, watch } from 'vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import { useAiStore } from '@/stores/ai';

/**
 * 一个功能的 API：选渠道 → 地址 → Key → 模型（可以拉取列表）→ 测试连接。
 * 测试失败、拉取失败都把完整报错（请求地址、状态码、服务端原文）显示出来。
 * api、key 都是草稿，保存由外面决定。
 */
const props = defineProps<{ role: AgentRole; backup?: boolean; testVoice?: VoiceSpec }>();
const api = defineModel<FeatureApi | null>('api', { required: true });
const key = defineModel<string>('apiKey', { required: true });

const ai = useAiStore();
const cap = computed(() => AGENT_META[props.role].capability);
const text = computed(() => isTextRole(props.role));
const channels = computed(() => channelsFor(props.role));
const info = computed(() => (api.value ? CHANNELS[api.value.channel] : null));
const kind = computed(() => (api.value ? kindOf(api.value, props.role) : null));
const uid = `api-${props.role}-${props.backup ? 'b' : 'a'}`;

/** 发出去之前怎么整理消息（同 SillyTavern 的 Prompt Post-Processing） */
const PROCESSING: { value: PromptProcessing; label: string; hint: string }[] = [
  { value: 'none', label: '原样', hint: '消息原样发出' },
  { value: 'merge', label: '合并', hint: '名字写进正文，同一角色连续的消息合成一条' },
  { value: 'semi', label: '半严格', hint: '合并之后，把中途的系统消息改成 user（DeepSeek 推理模型这类要求角色交替的用）' },
  { value: 'strict', label: '严格', hint: '半严格之后，保证系统消息后第一条是 user（转发到 Claude 的中转常要求）' },
  { value: 'single', label: '单条', hint: '全部合成一条 user 消息（只认一条消息的接口用）' },
];

function pickChannel(ch: ApiChannel) {
  if (api.value?.channel === ch) return;
  api.value = newFeatureApi(ch, props.role);
  fetchError.value = '';
  resetAdvanced();
}
function setFormat(f: CustomFormat) {
  if (api.value) api.value.format = f === 'gemini' ? undefined : f;
}
function setExtra(field: string, value: string) {
  const a = api.value;
  if (!a) return;
  const extra = { ...(a.extra ?? {}) };
  if (value.trim()) extra[field] = value.trim();
  else delete extra[field];
  a.extra = Object.keys(extra).length ? extra : undefined;
}
const cosyEmotion = computed({
  get: () => api.value?.extra?.emotion !== 'off',
  set: (on: boolean) => setExtra('emotion', on ? '' : 'off'),
});

// —— Key ——
const showKey = ref(false);
const keyOptional = computed(() => !!api.value && !needsKey(api.value));

// —— 模型 ——
const fetching = ref(false);
const fetchError = ref('');
const modelDraft = ref('');
async function fetchModels() {
  const a = api.value;
  if (!a) return;
  fetchError.value = '';
  const ep = ai.endpointOf(a, props.role, key.value, { backup: props.backup, listing: true });
  if ('reason' in ep) {
    fetchError.value = ep.reason;
    return;
  }
  fetching.value = true;
  try {
    const list = await listModels(ep, undefined, cap.value);
    if (!list.length) fetchError.value = '没有拉到模型（服务端返回的列表是空的），可以在下面手动填';
    // Vertex 的 API Key 拉不到模型列表（要 OAuth，同 math-reader）：列出常用的，保留已经填的
    else a.models = a.channel === 'vertex' ? [...new Set([...a.models, ...list])] : list;
    if (list.length && !a.model) a.model = list[0] ?? '';
  } catch (e) {
    fetchError.value = errorReport(e);
  } finally {
    fetching.value = false;
  }
}
function addModel() {
  const a = api.value;
  const m = modelDraft.value.trim();
  if (!a || !m) return;
  if (!a.models.includes(m)) a.models = [...a.models, m];
  a.model = m;
  modelDraft.value = '';
}
function removeModel(m: string) {
  const a = api.value;
  if (!a) return;
  a.models = a.models.filter((x) => x !== m);
  if (a.model === m) a.model = '';
}

// —— 高级（仅 OpenAI 格式的对话）：额外参数写 JSON，去掉的参数用逗号隔开 ——
const advancedOpen = ref(false);
const includeDraft = ref('');
const excludeDraft = ref('');
const includeError = ref('');
const showAdvanced = computed(() => text.value && (kind.value === 'openai' || kind.value === 'deepseek'));
const processingHint = computed(() => PROCESSING.find((p) => p.value === (api.value?.promptProcessing ?? 'none'))?.hint ?? '');
function resetAdvanced() {
  includeDraft.value = api.value?.includeBody ? JSON.stringify(api.value.includeBody, null, 2) : '';
  excludeDraft.value = (api.value?.excludeBody ?? []).join(', ');
  includeError.value = '';
}
resetAdvanced();
// 外面整个换掉了设置（照搬别的功能）：草稿跟着换
watch(
  () => api.value,
  () => {
    resetAdvanced();
    fetchError.value = '';
  },
);
function applyInclude() {
  const a = api.value;
  if (!a) return;
  const t = includeDraft.value.trim();
  if (!t) {
    a.includeBody = undefined;
    includeError.value = '';
    return;
  }
  try {
    const v: unknown = JSON.parse(t);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    a.includeBody = Object.keys(v).length ? (v as Record<string, unknown>) : undefined;
    includeError.value = '';
  } catch {
    includeError.value = '要写成 JSON 对象，例如 {"top_k": 40}；写对之前不会生效';
  }
}
function applyExclude() {
  const a = api.value;
  if (!a) return;
  const list = excludeDraft.value
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  a.excludeBody = list.length ? list : undefined;
}

// —— 测试连接 ——
const testing = ref(false);
async function runTest() {
  const a = api.value;
  if (!a) return;
  const ep = ai.endpointOf(a, props.role, key.value, { backup: props.backup });
  if ('reason' in ep) {
    a.lastTest = { ok: false, at: Date.now(), message: ep.reason };
    return;
  }
  testing.value = true;
  try {
    const r = await testConnection(ep, cap.value === 'vision' ? 'chat' : cap.value, { voice: cap.value === 'tts' ? props.testVoice : undefined });
    a.lastTest = { ok: r.ok, at: Date.now(), latencyMs: r.latencyMs, message: r.message, ...(r.detail ? { detail: r.detail } : {}) };
  } catch (e) {
    a.lastTest = { ok: false, at: Date.now(), message: errorText(e), detail: errorReport(e) };
  } finally {
    testing.value = false;
  }
}

// 换了地址、Key、模型，上次的测试结果就不作数了
watch(
  () => [api.value?.channel, api.value?.format, api.value?.baseUrl, api.value?.model, key.value],
  (now, before) => {
    if (before && api.value?.lastTest && JSON.stringify(now) !== JSON.stringify(before)) api.value.lastTest = undefined;
  },
);
</script>

<template>
  <div class="api-form">
    <label class="field-label">渠道</label>
    <div class="flex flex-wrap gap-1.5">
      <button v-for="ch in channels" :key="ch" type="button" class="opt" :class="{ on: api?.channel === ch }" :data-channel="ch" @click="pickChannel(ch)">{{ CHANNELS[ch].label }}</button>
    </div>
    <p v-if="info" class="hint">{{ info.hint }}</p>
    <p v-else class="hint">先选一个渠道</p>

    <template v-if="api && info">
      <template v-if="api.channel === 'custom' && text">
        <label class="field-label">请求格式</label>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="(label, f) in CUSTOM_FORMAT_LABEL" :key="f" type="button" class="opt" :class="{ on: (api.format ?? 'gemini') === f }" @click="setFormat(f as CustomFormat)">{{ label }}</button>
        </div>
      </template>

      <label class="field-label" :for="`${uid}-url`">地址</label>
      <input :id="`${uid}-url`" v-model="api.baseUrl" class="input" inputmode="url" autocomplete="off" spellcheck="false" :placeholder="info.urlPlaceholder" />

      <label class="field-label" :for="`${uid}-key`">{{ info.keyLabel ?? 'Key' }}{{ keyOptional ? '（可以不填）' : '' }}</label>
      <div class="key-row">
        <textarea
          v-if="api.channel === 'vertex' && showKey"
          :id="`${uid}-key`"
          v-model="key"
          class="textarea mono flex-1"
          rows="3"
          autocomplete="off"
          spellcheck="false"
          :placeholder="info.keyPlaceholder ?? 'sk-…'"
        />
        <input
          v-else
          :id="`${uid}-key`"
          v-model="key"
          class="input flex-1"
          :type="showKey ? 'text' : 'password'"
          autocomplete="off"
          spellcheck="false"
          :placeholder="info.keyPlaceholder ?? 'sk-…'"
        />
        <button type="button" class="eye" :aria-label="showKey ? '隐藏 Key' : '显示 Key'" @click="showKey = !showKey"><span :class="showKey ? 'i-lucide-eye-off' : 'i-lucide-eye'" /></button>
      </div>
      <p class="hint">只存在这台设备上，不会同步。</p>

      <template v-if="api.channel === 'minimax'">
        <label class="field-label" :for="`${uid}-group`">GroupId（老账号需要，新账号可以不填）</label>
        <input :id="`${uid}-group`" :value="api.extra?.groupId ?? ''" class="input" autocomplete="off" @input="setExtra('groupId', ($event.target as HTMLInputElement).value)" />
      </template>
      <template v-if="api.channel === 'vertex'">
        <label class="field-label" :for="`${uid}-location`">地区（只在用服务账号时用；空着用 global）</label>
        <input :id="`${uid}-location`" :value="api.extra?.location ?? ''" class="input" placeholder="global" autocomplete="off" @input="setExtra('location', ($event.target as HTMLInputElement).value)" />
        <label class="field-label" :for="`${uid}-project`">项目 ID（服务账号 JSON 里有就不用填）</label>
        <input :id="`${uid}-project`" :value="api.extra?.projectId ?? ''" class="input" autocomplete="off" @input="setExtra('projectId', ($event.target as HTMLInputElement).value)" />
      </template>
      <template v-if="api.channel === 'volcengine'">
        <label class="field-label" :for="`${uid}-appid`">APP ID（火山引擎控制台 → 豆包语音 → 应用管理）</label>
        <input :id="`${uid}-appid`" :value="api.extra?.appId ?? ''" class="input" inputmode="numeric" autocomplete="off" @input="setExtra('appId', ($event.target as HTMLInputElement).value)" />
        <label class="field-label" :for="`${uid}-resource`">Resource ID（空着用 seed-tts-2.0；复刻的 S_ 音色自动用 seed-icl-2.0）</label>
        <input :id="`${uid}-resource`" :value="api.extra?.resourceId ?? ''" class="input" placeholder="seed-tts-2.0" autocomplete="off" @input="setExtra('resourceId', ($event.target as HTMLInputElement).value)" />
      </template>
      <div v-if="cap === 'tts' && kind === 'openai'" class="flex items-center justify-between gap-3 mt-3">
        <div>
          <div class="text-[14px]">CosyVoice 情绪指令</div>
          <div class="text-[12px] text-ink-3">按她的表情加"请用害羞的语气说"；指令被读出来时关掉</div>
        </div>
        <van-switch v-model="cosyEmotion" class="shrink-0" size="22px" />
      </div>

      <label class="field-label" :for="`${uid}-model`">
        模型
        <button type="button" class="text-accent-ink ml-2" :disabled="fetching" @click="fetchModels">{{ fetching ? '拉取中…' : '拉取模型列表' }}</button>
      </label>
      <input :id="`${uid}-model`" v-model="api.model" class="input" autocomplete="off" spellcheck="false" :placeholder="cap === 'tts' ? '空着用服务商的默认模型' : '点下面的模型，或者直接填'" />
      <div v-if="api.models.length" class="models">
        <span v-for="m in api.models" :key="m" class="model" :class="{ on: api.model === m }">
          <button type="button" class="model-name" @click="api.model = m">{{ m }}</button>
          <button type="button" class="model-x" :aria-label="`从列表里去掉 ${m}`" @click="removeModel(m)"><span class="i-lucide-x" /></button>
        </span>
      </div>
      <div class="flex gap-2 mt-2">
        <input v-model="modelDraft" class="input flex-1" placeholder="手动添加模型名" autocomplete="off" spellcheck="false" @keydown.enter="addModel" />
        <van-button size="small" round @click="addModel">添加</van-button>
      </div>
      <ErrorDetails v-if="fetchError" :detail="fetchError" title="拉取模型列表失败" />

      <template v-if="showAdvanced">
        <button type="button" class="adv-toggle" @click="advancedOpen = !advancedOpen">
          <span>高级：消息整理、请求参数</span>
          <span :class="advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
        </button>
        <template v-if="advancedOpen">
          <label class="field-label">发出去之前怎么整理消息</label>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="p in PROCESSING"
              :key="p.value"
              type="button"
              class="opt"
              :class="{ on: (api.promptProcessing ?? 'none') === p.value }"
              @click="api.promptProcessing = p.value === 'none' ? undefined : p.value"
            >
              {{ p.label }}
            </button>
          </div>
          <p class="hint">{{ processingHint }}</p>
          <label class="field-label" :for="`${uid}-include`">额外请求参数（JSON，并进每次的请求体）</label>
          <textarea :id="`${uid}-include`" v-model="includeDraft" class="textarea mono" rows="3" placeholder='{"top_k": 40}' spellcheck="false" @change="applyInclude" @blur="applyInclude" />
          <p v-if="includeError" class="text-[12px] text-bad mt-1 mb-0">{{ includeError }}</p>
          <label class="field-label" :for="`${uid}-exclude`">去掉的请求参数（逗号隔开，例如中转不认的字段）</label>
          <input :id="`${uid}-exclude`" v-model="excludeDraft" class="input" placeholder="presence_penalty, frequency_penalty" autocomplete="off" spellcheck="false" @change="applyExclude" @blur="applyExclude" />
        </template>
      </template>

      <van-button round block class="!mt-4" :loading="testing" loading-text="测试中" :data-test="uid" @click="runTest">测试连接</van-button>
      <template v-if="api.lastTest">
        <div v-if="api.lastTest.ok" class="test-ok" role="status"><span class="i-lucide-circle-check" />连接正常{{ api.lastTest.latencyMs ? ` ${api.lastTest.latencyMs}ms` : '' }} · {{ api.lastTest.message }}</div>
        <ErrorDetails v-else :detail="api.lastTest.detail ?? api.lastTest.message" title="连接失败" />
      </template>
    </template>
  </div>
</template>

<style scoped>
.hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-3);
}
.opt {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.key-row {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.eye {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  max-height: 132px;
  overflow-y: auto;
}
.model {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.model.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.model-name {
  height: 30px;
  padding: 0 4px 0 11px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-x {
  height: 30px;
  padding: 0 9px 0 3px;
  font-size: 11px;
  opacity: 0.6;
}
.adv-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin-top: 14px;
  padding: 10px 0 2px;
  border-top: 1px dashed var(--border);
  font-size: 13.5px;
  color: var(--ink-2);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}
.test-ok {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--good);
  font-size: 12.5px;
  line-height: 1.55;
  word-break: break-word;
}
.test-ok > span {
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
