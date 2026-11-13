<script setup lang="ts">
import { apiLabel, channelsFor, compileFilter, DEFAULT_IMAGE_STYLE, DEFAULT_OUTPUT_FILTERS, encodeVector, errorReport, kindOf, newFeatureApi, type VoiceSpec } from '@app/ai';
import { AGENT_META, apiKeyId, followOf, followOptions, isTextRole, type AgentRole, type AgentRoute, type FeatureApi, type FollowTarget, type ReasoningEffort } from '@app/shared';
import { showToast } from 'vant';
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import Segmented from '@/components/common/Segmented.vue';
import ApiForm from '@/components/settings/ApiForm.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { sliceText, useMemoryStore } from '@/stores/memory';
import { cosine, services } from '@/services';
import { voiceSpec } from '@/services/ai';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { showErrorDialog } from '@/utils/errors';
import { hhmm } from '@/utils/time';

/**
 * API 设置（按功能分，不按渠道分）：
 * - 每个功能自己选渠道、填地址、Key、模型，可以再设一个失败时改用的备用 API；
 * - 文本功能（主对话、番外、总结、生图提示词、主动消息、识图）的渠道：自定义、Claude、OpenAI 兼容、Gemini、Vertex Agent、DeepSeek；
 *   主对话以外的默认跟随主对话；
 * - 其他功能（向量化、语音合成、语音识别、生图）的渠道：自定义（OpenAI 格式）和能做这件事的几家；
 * - 测试连接、拉取模型、调用失败都显示完整报错。
 * 设置存在本机，Key 单独存、只在这台设备上。能用的功能真的调用，其余继续用演示模型。
 */
const ai = useAiStore();
const chars = useCharacterStore();

const GROUPS: { title: string; roles: AgentRole[]; note: string }[] = [
  {
    title: '文字',
    roles: ['main', 'companion', 'sidestory', 'summary', 'consolidate', 'imagePrompt', 'rhythm', 'proactive', 'vision'],
    note: '渠道可选自定义、Claude、OpenAI 兼容、Gemini、Vertex Agent、DeepSeek。「陪伴 · 快速」写一起做事时的短句，选便宜、快的模型；生图提示词和节律默认跟随它。其余功能可以跟随主对话或「陪伴 · 快速」，也可以单独设置。',
  },
  { title: '语音', roles: ['tts', 'stt'], note: '语音合成可选自定义（OpenAI 格式 /audio/speech）、硅基流动、MiniMax、火山引擎、Fish Audio、GPT-SoVITS；音色在"我的 → 语音"里按角色设置。' },
  { title: '图片', roles: ['image'], note: '生图可选自定义（OpenAI 格式 /images/generations）、NovelAI（含公益站）、硅基流动。' },
  { title: '记忆', roles: ['embedding'], note: '向量化可选自定义（OpenAI 格式 /embeddings）、硅基流动、Gemini。备用 API 只在模型相同时才会用：不同模型的向量不能互相比较，换了模型要重算向量。' },
];
/** 提示词和采样参数在预设里的功能（温度不在这里调） */
const PRESET_DRIVEN: Partial<Record<AgentRole, string>> = { companion: '"功能"', sidestory: '"小剧场"', summary: '"总结"', consolidate: '"总结"', imagePrompt: '"生图"', proactive: '"主动消息"' };
/** 后台跑的功能可以设每日上限（总结、记忆整理不设上限） */
const BUDGETED = new Set<AgentRole>(['sidestory', 'imagePrompt', 'proactive', 'embedding']);
/** 推理强度：OpenAI 的 reasoning_effort、Claude 的思考预算 / effort、Gemini 的 thinkingBudget / thinkingLevel */
const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'none', label: '关闭' },
  { value: 'min', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最高' },
];
const NAI_SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde'];
const NAI_SCHEDULES = ['karras', 'native', 'exponential', 'polyexponential'];

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
/** 这个功能跟随谁；单独设置时为空 */
const following = (role: AgentRole): FollowTarget | null => followOf(ai.routeOf(role));

/** 卡片上的一行：用的哪个渠道、哪个模型（跟随别的功能时是最终用的那个） */
function cardLine(role: AgentRole): string {
  const target = following(role);
  if (!target) return ai.apiLine(role, ai.routeOf(role).api);
  const source = ai.system.router.source(role);
  return `跟随${AGENT_META[target].label} · ${ai.apiLine(source, ai.routeOf(source).api)}`;
}
function backupLine(role: AgentRole): string {
  const b = ai.effectiveRoute(role).backup;
  return b ? `失败时改用 ${apiLabel(b, role)} · ${b.model || '未选模型'}` : '';
}
function statusOf(role: AgentRole): { live: boolean; text: string } {
  const s = ai.status(role);
  return s.live ? { live: true, text: '已接通' } : { live: false, text: `演示模型 · ${s.reason}` };
}
/** 卡片上要不要提示"上次测试失败"：只看自己的 API */
function failedTest(role: AgentRole): FeatureApi | null {
  if (following(role)) return null;
  const a = ai.routeOf(role).api;
  return a?.lastTest && !a.lastTest.ok ? a : null;
}

// —— 一个功能的设置（草稿，保存时写回）——
const draft = ref<AgentRoute | null>(null);
const keys = reactive({ api: '', backup: '' });
const sheetOpen = computed({ get: () => !!draft.value, set: (v) => !v && (draft.value = null) });
const draftRole = computed(() => draft.value?.role ?? 'main');
/** 正在改的功能跟随谁；单独设置时为空 */
const draftFollow = computed<FollowTarget | null>(() => (draft.value ? followOf(draft.value) : null));
/** 跟随时最终用哪个功能的 API（跟随「陪伴 · 快速」、它又跟随主对话时是主对话） */
const draftSource = computed<AgentRole | null>(() => (draftFollow.value ? ai.system.router.source(draftFollow.value) : null));
/** "用哪个 API"能选的：跟随谁 + 单独设置 */
const followChoices = computed(() => [
  ...followOptions(draftRole.value).map((t) => ({ value: t as string, label: `跟随${AGENT_META[t].label}` })),
  { value: 'own', label: '单独设置' },
]);
const isText = computed(() => isTextRole(draftRole.value));
const cap = computed(() => AGENT_META[draftRole.value].capability);

function openFeature(role: AgentRole) {
  const r = clone(ai.routeOf(role));
  if (role === 'image' && !r.imageStyle) r.imageStyle = clone(DEFAULT_IMAGE_STYLE);
  draft.value = r;
  keys.api = ai.keyOf(apiKeyId(role)) ?? '';
  keys.backup = ai.keyOf(apiKeyId(role, true)) ?? '';
}
// 从别处直接跳到某个功能的设置（例如聊天里"生成配图"没接通时 → ?feature=image）；已经在这一页时换个功能也跟着换
const route = useRoute();
watch(
  () => route.query.feature,
  (f) => {
    if (typeof f === 'string' && f in AGENT_META && ai.routeOf(f as AgentRole)) openFeature(f as AgentRole);
  },
  { immediate: true },
);
const followModel = computed({
  get: () => draftFollow.value ?? 'own',
  set: (v: string) => {
    if (!draft.value) return;
    draft.value.follow = v === 'main' || v === 'companion' ? v : null;
    delete draft.value.sameAsMain;
  },
});
/** 照搬别的功能的设置（同一类渠道的）：渠道、地址、模型、Key 一起 */
const copySources = computed(() => {
  const role = draftRole.value;
  const allowed = channelsFor(role);
  return (Object.keys(AGENT_META) as AgentRole[])
    .filter((r) => r !== role && !following(r))
    .map((r) => ({ role: r, api: ai.routeOf(r).api }))
    .filter((x): x is { role: AgentRole; api: FeatureApi } => !!x.api && allowed.includes(x.api.channel) && (isTextRole(x.role) === isTextRole(role) || x.api.channel !== 'custom'));
});
function copyFrom(src: AgentRole) {
  const d = draft.value;
  const a = ai.routeOf(src).api;
  if (!d || !a) return;
  // 同一类功能整个照搬；不同类的（向量化 → 语音合成）只搬渠道、地址、Key，模型换成这个功能的常用模型
  const sameKind = isTextRole(src) ? isTextRole(d.role) : AGENT_META[src].capability === AGENT_META[d.role].capability;
  d.api = sameKind ? { ...clone(a), lastTest: undefined } : { ...newFeatureApi(a.channel, d.role), baseUrl: a.baseUrl, ...(a.headers ? { headers: clone(a.headers) } : {}) };
  keys.api = ai.keyOf(apiKeyId(src)) ?? '';
  showToast(sameKind ? `已照搬${AGENT_META[src].label}的设置` : `已照搬${AGENT_META[src].label}的地址和 Key`);
}
const backupOn = computed({
  get: () => !!draft.value?.backup,
  set: (on: boolean) => {
    const d = draft.value;
    if (!d) return;
    d.backup = on ? newFeatureApi(d.api?.channel ?? channelsFor(d.role)[0] ?? 'custom', d.role) : null;
    if (!on) keys.backup = '';
  },
});
/** 测语音合成时用的音色：第一个设了音色的角色，否则用服务商的系统音色 */
const testVoice = computed<VoiceSpec | undefined>(() => {
  const who = chars.list.find((c) => c.voice.voiceId);
  return who ? voiceSpec(who) : undefined;
});

const temperature = computed({
  get: () => draft.value?.params?.temperature ?? 1,
  set: (t: number) => {
    const r = draft.value;
    if (r) r.params = { ...(r.params ?? {}), temperature: Math.round(t * 100) / 100 };
  },
});
type RouteParams = NonNullable<AgentRoute['params']>;
function setParam<K extends keyof RouteParams>(k: K, v: RouteParams[K] | undefined) {
  const r = draft.value;
  if (!r) return;
  const params: RouteParams = { ...(r.params ?? {}) };
  if (v === undefined) delete params[k];
  else params[k] = v;
  r.params = Object.keys(params).length ? params : undefined;
}
const effort = computed({
  get: (): ReasoningEffort => draft.value?.params?.reasoningEffort ?? 'auto',
  set: (v: ReasoningEffort) => setParam('reasoningEffort', v === 'auto' ? undefined : v),
});
/** 默认跟着流式走（流式时返回思考过程）；关掉就不要 */
const includeReasoning = computed({
  get: () => draft.value?.params?.includeReasoning !== false,
  set: (on: boolean) => setParam('includeReasoning', on ? undefined : false),
});
/** 生图用的渠道（决定显示哪些生图设置） */
const imageKind = computed(() => (draft.value?.role === 'image' && draft.value.api ? kindOf(draft.value.api, 'image') : null));
function setStyleNumber(field: 'steps' | 'scale', value: string) {
  const s = draft.value?.imageStyle;
  if (!s) return;
  const n = Number(value);
  s[field] = value.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
}
function resetStyle() {
  const r = draft.value;
  if (r) r.imageStyle = clone(DEFAULT_IMAGE_STYLE);
}

function saveFeature() {
  const d = draft.value;
  if (!d) return;
  if (d.api) d.api.model = d.api.model.trim();
  if (d.backup) d.backup.model = d.backup.model.trim();
  ai.saveRoute(d);
  ai.setKey(apiKeyId(d.role), d.api ? keys.api : null);
  ai.setKey(apiKeyId(d.role, true), d.backup ? keys.backup : null);
  draft.value = null;
  showToast('已保存');
}

// —— 回复修剪（SleepTogether 的全局正则）——
const filterOpen = ref(false);
const filterDraft = ref('');
const badFilters = computed(() =>
  filterDraft.value
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x && !compileFilter(x)),
);
function openFilters() {
  filterDraft.value = ai.outputFilters.join('\n');
  filterOpen.value = true;
}
function saveFilters() {
  if (badFilters.value.length) {
    showToast(`有 ${badFilters.value.length} 条写错了，改好再保存`);
    return;
  }
  ai.setOutputFilters(filterDraft.value.split('\n'));
  filterOpen.value = false;
  showToast('已保存');
}

// —— 向量化：测试相似度 / 重算 ——
const simOpen = ref(false);
const simA = ref('他不吃香菜');
const simB = ref('点外卖时记得备注不要放芫荽');
const simResult = ref<number | null>(null);
const simError = ref('');
const simLoading = ref(false);
async function runSim() {
  simLoading.value = true;
  simError.value = '';
  try {
    const [a, b] = await services.embedding.embed([simA.value, simB.value]);
    simResult.value = a && b ? cosine(a, b) : null;
  } catch (e) {
    simResult.value = null;
    simError.value = errorReport(e);
  } finally {
    simLoading.value = false;
  }
}
const reindex = ref<{ done: number; total: number } | null>(null);
const memoryStore = useMemoryStore();
/** 在用的记忆和故事片段（重算向量、显示条数用） */
const embedCount = computed(() => ({
  memories: memoryStore.memories.filter((m) => !m.deleted && m.status !== 'superseded').length,
  slices: memoryStore.slices.filter((s) => !s.deleted).length,
}));
async function runReindex() {
  const list = [
    ...memoryStore.memories.filter((m) => !m.deleted && m.status !== 'superseded').map((m) => ({ kind: 'memory' as const, id: m.id, text: m.content })),
    ...memoryStore.slices.filter((x) => !x.deleted).map((x) => ({ kind: 'slice' as const, id: x.id, text: sliceText(x) })),
  ];
  const total = list.length;
  reindex.value = { done: 0, total };
  try {
    for (let i = 0; i < total; i += 16) {
      const batch = list.slice(i, i + 16);
      const vectors = await services.embedding.embed(batch.map((m) => m.text));
      if (services.embedding.live) {
        batch.forEach((m, j) => {
          const v = vectors[j];
          if (v) memoryStore.setVector(m.kind, m.id, v, services.embedding.model);
        });
      }
      reindex.value = { done: Math.min(total, i + batch.length), total };
    }
    showToast(services.embedding.live ? `已用 ${services.embedding.model} 重算 ${total} 条记忆和片段` : `演示：重算了 ${total} 条（假向量）`);
  } catch (e) {
    showErrorDialog('重算向量失败', e);
  } finally {
    setTimeout(() => (reindex.value = null), 1200);
  }
}
</script>

<template>
  <div class="page" data-page="api">
    <PageHeader title="API 设置" subtitle="按功能设置：每个功能自己选渠道、填地址和 Key" fallback="/me" />
    <div class="page-scroll pb-10">
      <template v-for="g in GROUPS" :key="g.title">
        <div class="group-title">{{ g.title }}</div>
        <div class="px-4 grid gap-2">
          <div v-for="role in g.roles" :key="role" class="feature" :data-role="role">
            <button class="flex items-center gap-3 w-full text-left" @click="openFeature(role)">
              <span class="feature-icon"><span :class="AGENT_META[role].icon" /></span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="text-[14.5px] font-600">{{ AGENT_META[role].label }}</span>
                  <span v-if="following(role)" class="tag">跟随{{ AGENT_META[following(role)!].label }}</span>
                </div>
                <div class="text-[12.5px] text-ink-2 truncate">{{ cardLine(role) }}</div>
                <div v-if="backupLine(role)" class="text-[11.5px] text-ink-3 truncate">{{ backupLine(role) }}</div>
                <div class="live-line" :class="statusOf(role).live ? 'on' : 'off'">{{ statusOf(role).text }}</div>
              </div>
              <span class="i-lucide-chevron-right text-ink-3" />
            </button>
            <button v-if="ai.lastErrors[role]" class="fail-line" @click="showErrorDialog(`${AGENT_META[role].label}：调用失败`, ai.lastErrors[role]!.detail)">
              <span class="i-lucide-circle-alert shrink-0" />
              <span class="flex-1 min-w-0 truncate">{{ hhmm(ai.lastErrors[role]!.at) }} 调用失败：{{ ai.lastErrors[role]!.summary }}</span>
              <span class="shrink-0 underline">完整报错</span>
            </button>
            <button v-else-if="failedTest(role)" class="fail-line" @click="showErrorDialog(`${AGENT_META[role].label}：测试连接失败`, failedTest(role)!.lastTest!.detail ?? failedTest(role)!.lastTest!.message)">
              <span class="i-lucide-circle-alert shrink-0" />
              <span class="flex-1 min-w-0 truncate">上次测试失败：{{ failedTest(role)!.lastTest!.message }}</span>
              <span class="shrink-0 underline">完整报错</span>
            </button>
            <div v-if="role === 'embedding'" class="embed-tools">
              <span class="text-[12px] text-ink-3 num">
                {{ services.embedding.live ? `${services.embedding.model} · ${services.embedding.dims || '—'} 维` : '演示用假向量' }} · {{ embedCount.memories }} 条记忆 · {{ embedCount.slices }} 个片段 · 检索在本机
              </span>
              <div class="flex gap-2 mt-2">
                <van-button size="small" round @click="simOpen = true">测试相似度</van-button>
                <van-button size="small" round :loading="!!reindex" loading-text="重算中" @click="runReindex">用新模型重算全部向量</van-button>
              </div>
              <van-progress v-if="reindex" class="mt-2" :percentage="Math.round((reindex.done / Math.max(1, reindex.total)) * 100)" stroke-width="5" />
            </div>
          </div>
        </div>
        <p class="note">{{ g.note }}</p>
      </template>

      <div class="group-title">回复修剪</div>
      <div class="px-4">
        <button class="feature flex items-center gap-3 w-full text-left press" @click="openFilters">
          <span class="feature-icon"><span class="i-lucide-scissors" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[14.5px] font-600">{{ ai.outputFilters.length ? `${ai.outputFilters.length} 条规则` : '不修剪' }}</div>
            <div class="text-[12.5px] text-ink-2 truncate">所有文本功能的回复先过一遍这些正则</div>
          </div>
          <span class="i-lucide-chevron-right text-ink-3" />
        </button>
      </div>
      <p class="note">默认去掉漏出来的思考内容：&lt;think&gt;…&lt;/think&gt;、只剩结束标签的半截思考、&lt;!-- consider: … --&gt; 注释（同 SleepTogether）。Key 保存在本机；云端主动消息和每日节律所用的 Key 会加密保存到你连接的 Worker。</p>
    </div>

    <!-- 一个功能的设置 -->
    <van-popup v-model:show="sheetOpen" position="bottom" round :style="{ maxHeight: '92%' }">
      <div v-if="draft" :key="draft.role" class="sheet" :data-sheet="draft.role">
        <div class="sheet-title">{{ AGENT_META[draft.role].label }}</div>
        <div class="text-[12.5px] text-ink-3 mt-0.5">{{ AGENT_META[draft.role].desc }}</div>

        <template v-if="followOptions(draft.role).length">
          <label class="field-label">用哪个 API</label>
          <Segmented v-model="followModel" :options="followChoices" />
        </template>

        <template v-if="draftFollow && draftSource">
          <div class="follow-box">
            <div class="text-[13px] text-ink-2">
              现在用：{{ ai.apiLine(draftSource, ai.routeOf(draftSource).api) }}<template v-if="draftSource !== draftFollow">（{{ AGENT_META[draftFollow].label }}跟随{{ AGENT_META[draftSource].label }}）</template>
            </div>
            <div v-if="backupLine(draftSource)" class="text-[12px] text-ink-3 mt-0.5">{{ backupLine(draftSource) }}</div>
            <button class="text-[13px] text-accent-ink mt-1.5" @click="openFeature(draftFollow)">去设置{{ AGENT_META[draftFollow].label }}</button>
          </div>
        </template>
        <template v-else>
          <template v-if="copySources.length">
            <label class="field-label">照搬别的功能的设置（地址、Key 一起）</label>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="s in copySources" :key="s.role" type="button" class="opt" @click="copyFrom(s.role)">{{ AGENT_META[s.role].label }} · {{ apiLabel(s.api, s.role) }}</button>
            </div>
          </template>
          <ApiForm v-model:api="draft.api" v-model:api-key="keys.api" :role="draft.role" :test-voice="testVoice" />

          <div v-if="draft.api" class="backup-box">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-[14px] font-600">备用 API</div>
                <div class="text-[12px] text-ink-3">上面的调用失败时改用它{{ cap === 'tts' ? '（只在同一家服务商之间换：音色不通用）' : '' }}</div>
              </div>
              <van-switch v-model="backupOn" class="shrink-0" size="22px" />
            </div>
            <ApiForm v-if="draft.backup" v-model:api="draft.backup" v-model:api-key="keys.backup" :role="draft.role" backup :test-voice="testVoice" />
          </div>
        </template>

        <template v-if="isText || draft.role === 'image' || BUDGETED.has(draft.role)">
          <div class="params-title">参数</div>
        </template>
        <template v-if="cap === 'chat' && draft.role !== 'main' && !PRESET_DRIVEN[draft.role]">
          <label class="field-label">温度 {{ temperature.toFixed(2) }}（越高越有想象力）</label>
          <van-slider v-model="temperature" :min="0" :max="1.5" :step="0.05" bar-height="4px" button-size="16px" />
        </template>
        <p v-if="draft.role === 'main'" class="text-[12px] text-ink-3 mt-2 mb-0">主对话的温度、回复长度等参数以预设为准（平时用角色的对话预设，一起做事时用那件事的功能预设）。</p>
        <p v-else-if="PRESET_DRIVEN[draft.role]" class="text-[12px] text-ink-3 mt-2 mb-0">
          温度、回复长度和提示词以{{ PRESET_DRIVEN[draft.role] }}预设为准，在 <RouterLink to="/me/presets" class="text-accent-ink">我的 → 预设</RouterLink> 里改。
        </p>
        <template v-if="isText">
          <label class="field-label">推理强度（模型支持思考时）</label>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="e in EFFORTS" :key="e.value" type="button" class="opt" :class="{ on: effort === e.value }" @click="effort = e.value">{{ e.label }}</button>
          </div>
          <p class="text-[12px] text-ink-3 mt-1.5 mb-0">
            按各家换算：OpenAI 的 reasoning_effort、Claude 的思考预算、Gemini 的思考预算或等级、DeepSeek 的思考开关。"关闭"在 DeepSeek 上关掉思考模式（默认是开的），回复更快。{{
              draft.role === 'main' ? '预设里设了推理强度时以预设为准。' : ''
            }}
          </p>
          <div class="flex items-center justify-between gap-3 mt-3">
            <div>
              <div class="text-[14px]">返回思考过程</div>
              <div class="text-[12px] text-ink-3">流式时一起返回，消息上可以展开看；关掉省流量</div>
            </div>
            <van-switch v-model="includeReasoning" class="shrink-0" size="22px" />
          </div>
        </template>
        <template v-if="draft.role === 'image' && draft.imageStyle">
          <label class="field-label" for="style-prefix">固定前缀（画风、质量词；写 {prompt} 可以指定提示词放在哪）</label>
          <textarea id="style-prefix" v-model="draft.imageStyle.prefix" class="textarea" rows="2" spellcheck="false" />
          <label class="field-label" for="style-suffix">固定后缀</label>
          <input id="style-suffix" v-model="draft.imageStyle.suffix" class="input" autocomplete="off" spellcheck="false" />
          <label class="field-label" for="style-negative">固定负面词</label>
          <textarea id="style-negative" v-model="draft.imageStyle.negative" class="textarea" rows="3" spellcheck="false" />
          <template v-if="imageKind === 'novelai'">
            <div class="flex items-center justify-between gap-3 mt-3">
              <div>
                <div class="text-[14px]">追加官网的质量词</div>
                <div class="text-[12px] text-ink-3">同 NovelAI 网页版的 Add Quality Tags 和负面预设；前缀里写了质量词就关着</div>
              </div>
              <van-switch v-model="draft.imageStyle.naiQuality" class="shrink-0" size="22px" />
            </div>
            <div class="flex items-center justify-between gap-3 mt-3">
              <div>
                <div class="text-[14px]">Variety Boost</div>
                <div class="text-[12px] text-ink-3">构图、姿势更多样，不容易每张都一样</div>
              </div>
              <van-switch class="shrink-0" :model-value="!!draft.imageStyle.varietyBoost" size="22px" @update:model-value="draft.imageStyle.varietyBoost = $event ? true : undefined" />
            </div>
            <label class="field-label">采样器</label>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="s in NAI_SAMPLERS"
                :key="s"
                type="button"
                class="opt"
                :class="{ on: (draft.imageStyle.sampler ?? NAI_SAMPLERS[0]) === s }"
                @click="draft.imageStyle.sampler = s === NAI_SAMPLERS[0] ? undefined : s"
              >
                {{ s }}
              </button>
            </div>
            <label class="field-label">噪声调度</label>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="s in NAI_SCHEDULES" :key="s" type="button" class="opt" :class="{ on: draft.imageStyle.schedule === s }" @click="draft.imageStyle.schedule = draft.imageStyle.schedule === s ? undefined : s">
                {{ s }}
              </button>
            </div>
            <p class="text-[12px] text-ink-3 mt-1.5 mb-0">不选时 V4 用 karras、V3 用 native。</p>
          </template>
          <div v-if="imageKind === 'novelai' || imageKind === 'openai'" class="flex gap-2.5">
            <div class="flex-1">
              <label class="field-label" for="style-steps">步数</label>
              <input id="style-steps" class="input" inputmode="numeric" :value="draft.imageStyle.steps ?? ''" :placeholder="imageKind === 'novelai' ? '28' : '默认'" @input="setStyleNumber('steps', ($event.target as HTMLInputElement).value)" />
            </div>
            <div class="flex-1">
              <label class="field-label" for="style-scale">引导系数</label>
              <input id="style-scale" class="input" inputmode="decimal" :value="draft.imageStyle.scale ?? ''" :placeholder="imageKind === 'novelai' ? '5' : '默认'" @input="setStyleNumber('scale', ($event.target as HTMLInputElement).value)" />
            </div>
          </div>
          <button type="button" class="text-[13px] text-accent-ink mt-2.5" @click="resetStyle">恢复默认风格</button>
        </template>
        <template v-if="BUDGETED.has(draft.role)">
          <label class="field-label" for="route-budget">每天最多用多少 token（空着不限）</label>
          <input
            id="route-budget"
            class="input"
            inputmode="numeric"
            :value="draft.dailyTokenBudget ?? ''"
            placeholder="例如 100000"
            @input="draft.dailyTokenBudget = Number(($event.target as HTMLInputElement).value.replace(/\D/g, '')) || undefined"
          />
          <p class="text-[12px] text-ink-3 mt-1.5 mb-0 num">今天已用 {{ ai.system.usedToday(draft.role) }}</p>
        </template>

        <ErrorDetails v-if="ai.lastErrors[draft.role]" :detail="ai.lastErrors[draft.role]!.detail" :title="`${hhmm(ai.lastErrors[draft.role]!.at)} 调用失败的完整报错`" />
        <van-button round block type="primary" class="!mt-4" data-save @click="saveFeature">保存</van-button>
      </div>
    </van-popup>

    <!-- 回复修剪 -->
    <van-popup v-model:show="filterOpen" position="bottom" round :style="{ maxHeight: '90%' }">
      <div class="sheet">
        <div class="sheet-title">回复修剪</div>
        <div class="text-[12.5px] text-ink-3 mt-0.5">一行一条：/正则/标志，或者 &lt;标签&gt;&lt;/标签&gt;（去掉整段这个标签）。命中的内容从回复里删掉。</div>
        <textarea v-model="filterDraft" class="textarea mono mt-3" rows="6" spellcheck="false" aria-label="修剪规则" />
        <p v-for="b in badFilters" :key="b" class="text-[12px] text-bad mt-1 mb-0 break-all">写错了：{{ b }}</p>
        <button class="text-[13px] text-accent-ink mt-2.5" @click="filterDraft = DEFAULT_OUTPUT_FILTERS.join('\n')">恢复默认规则</button>
        <van-button round block type="primary" class="!mt-4" @click="saveFilters">保存</van-button>
      </div>
    </van-popup>

    <!-- 测试相似度 -->
    <van-popup v-model:show="simOpen" position="bottom" round>
      <div class="sheet">
        <div class="sheet-title">测试向量模型</div>
        <div class="text-[12.5px] text-ink-3 mt-0.5">输入两句意思相近的话，看看这个模型对中文认不认得出来</div>
        <label class="field-label" for="sim-a">第一句</label>
        <input id="sim-a" v-model="simA" class="input" />
        <label class="field-label" for="sim-b">第二句</label>
        <input id="sim-b" v-model="simB" class="input" />
        <van-button round block type="primary" class="!mt-4" :loading="simLoading" @click="runSim">计算相似度</van-button>
        <div v-if="simResult !== null" class="sim num">
          相似度 <b>{{ simResult.toFixed(2) }}</b>
          <span class="text-[12px] text-ink-3">{{ services.embedding.live ? `（${services.embedding.model}）` : '（演示用假向量；给"向量化"设置 API 并填 Key 后用真模型）' }}</span>
        </div>
        <ErrorDetails v-if="simError" :detail="simError" title="向量化失败" />
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.feature {
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.feature-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 18px;
  flex-shrink: 0;
}
.live-line {
  margin-top: 2px;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-line.on {
  color: var(--good);
}
.live-line.off {
  color: var(--ink-3);
}
.fail-line {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bad) 9%, var(--panel));
  color: var(--bad);
  font-size: 12px;
  text-align: left;
}
.embed-tools {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
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
.follow-box {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
}
.backup-box {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.params-title {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
  font-size: 14px;
  font-weight: 600;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}
.sim {
  margin-top: 14px;
  padding: 12px;
  border-radius: 14px;
  background: var(--panel);
  font-size: 14px;
}
.sim b {
  font-size: 22px;
  color: var(--accent-ink);
}
</style>
