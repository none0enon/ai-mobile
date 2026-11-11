<script setup lang="ts">
import { compileFilter, DEFAULT_IMAGE_STYLE, DEFAULT_OUTPUT_FILTERS, encodeVector, errorText, isSlotCapability, kindCan, listModels, testConnection, type VoiceSpec } from '@app/ai';
import {
  AGENT_META,
  API_SLOT_LABEL,
  API_SLOTS,
  type AgentRole,
  type ApiSlot,
  type AgentRoute,
  type Capability,
  type ConnectionKind,
  type KeyStorage,
  type PromptProcessing,
  type ProviderConnection,
  type ReasoningEffort,
} from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, ref } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { CONNECTION_TEMPLATES, type ConnectionTemplate } from '@/mock/api';
import { memories } from '@/mock/memories';
import { cosine, services } from '@/services';
import { voiceSpec } from '@/services/ai';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';

/**
 * API 与智能体：
 * - 主要 / 次要 / 备用 API（同 math-reader 的 API Setting）：各选一个连接和模型；
 *   对话、番外、总结等文字类智能体选用其中一套（同 math-reader 的 AI 功能分配），失败时改用备用 API；
 * - 连接 = 一个地址 + Key（OpenAI 兼容、Claude、Gemini、DeepSeek……）；
 * - 语音合成、生图、向量化等智能体单独选连接、模型、备用连接。
 * 设置存在本机，Key 单独存、只在这台设备上。能用的智能体真的调用，其余继续用演示模型。
 */
const ai = useAiStore();
const chars = useCharacterStore();

const KIND_LABEL: Record<ConnectionKind, string> = {
  openai: 'OpenAI 兼容',
  deepseek: 'DeepSeek',
  anthropic: 'Claude',
  gemini: 'Gemini（AI Studio）',
  vertex: 'Vertex Agent',
  novelai: 'NovelAI',
  minimax: 'MiniMax',
  volcengine: '火山引擎',
  'fish-audio': 'Fish Audio',
  'gpt-sovits': 'GPT-SoVITS',
  'workers-ai': 'Workers AI',
  'google-maps': 'Google 地图',
};
const CAP_LABEL: Record<Capability, string> = { chat: '对话', vision: '识图', embedding: '向量', tts: '语音合成', stt: '语音识别', image: '生图', maps: '地图' };
const KEY_LABEL: Record<KeyStorage, string> = { device: '只在本机', hub: '交给我的 Worker', none: '无需 Key' };
const RUNS_LABEL = { device: '本机', hub: 'Worker', auto: '自动' } as const;
const ROLES = Object.keys(AGENT_META) as AgentRole[];
/** 后台跑的智能体可以设每日上限 */
const BUDGETED = new Set<AgentRole>(['sidestory', 'summary', 'imagePrompt', 'proactive', 'embedding']);
/** 发出去之前怎么整理消息（同 SillyTavern 的 Prompt Post-Processing） */
const PROCESSING: { value: PromptProcessing; label: string; hint: string }[] = [
  { value: 'none', label: '原样', hint: '消息原样发出' },
  { value: 'merge', label: '合并', hint: '名字写进正文，同一角色连续的消息合成一条' },
  { value: 'semi', label: '半严格', hint: '合并之后，把中途的系统消息改成 user（DeepSeek 推理模型这类要求角色交替的用）' },
  { value: 'strict', label: '严格', hint: '半严格之后，保证系统消息后第一条是 user（转发到 Claude 的中转常要求）' },
  { value: 'single', label: '单条', hint: '全部合成一条 user 消息（只认一条消息的接口用）' },
];
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
/** Key 输入框的说明和占位 */
const KEY_HINT: Partial<Record<ConnectionKind, string>> = {
  novelai: '（持久 API Token，pst- 开头）',
  volcengine: '（Access Token）',
  vertex: '（API Key 或服务账号 JSON）',
};
const KEY_PLACEHOLDER: Partial<Record<ConnectionKind, string>> = {
  novelai: 'pst-…',
  volcengine: 'Access Token',
  vertex: 'API Key，或 {"type": "service_account", …}',
};
const NAI_SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde'];
const NAI_SCHEDULES = ['karras', 'native', 'exponential', 'polyexponential'];

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
function connName(id: string | null | undefined) {
  return ai.byId(id)?.name ?? '未选择';
}
function routeOf(role: AgentRole): AgentRoute {
  return ai.routeOf(role) as AgentRoute;
}

// —— 连接编辑 ——
const editing = ref<ProviderConnection | null>(null);
const isNew = ref(false);
const editOpen = computed({ get: () => !!editing.value, set: (v) => !v && (editing.value = null) });
const KEY_MASK = '••••••••••••';
const keyDraft = ref('');
const testing = ref(false);
const fetching = ref(false);
const modelDraft = ref('');
/** 高级（仅 OpenAI 兼容的对话）：额外参数写 JSON，去掉的参数用逗号隔开 */
const advancedOpen = ref(false);
const includeDraft = ref('');
const excludeDraft = ref('');
const includeError = ref('');

function resetAdvanced(c?: ProviderConnection) {
  includeDraft.value = c?.includeBody ? JSON.stringify(c.includeBody, null, 2) : '';
  excludeDraft.value = (c?.excludeBody ?? []).join(', ');
  includeError.value = '';
  advancedOpen.value = false;
}
/** 把高级里的草稿写回连接；额外参数不是 JSON 对象时不保存 */
function applyAdvanced(c: ProviderConnection): boolean {
  const text = includeDraft.value.trim();
  let include: Record<string, unknown> | undefined;
  if (text) {
    try {
      const v: unknown = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      include = v as Record<string, unknown>;
    } catch {
      includeError.value = '要写成 JSON 对象，例如 {"top_k": 40}';
      advancedOpen.value = true;
      return false;
    }
  }
  includeError.value = '';
  c.includeBody = include && Object.keys(include).length ? include : undefined;
  const exclude = excludeDraft.value
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  c.excludeBody = exclude.length ? exclude : undefined;
  if (c.promptProcessing === 'none') c.promptProcessing = undefined;
  return true;
}
const processingHint = computed(() => PROCESSING.find((p) => p.value === (editing.value?.promptProcessing ?? 'none'))?.hint ?? '');

function fromTemplate(t: ConnectionTemplate): ProviderConnection {
  const now = Date.now();
  return {
    id: `conn-${now.toString(36)}`,
    createdAt: now,
    updatedAt: now,
    name: t.name,
    kind: t.kind,
    baseUrl: t.baseUrl,
    keyStorage: t.keyStorage ?? 'device',
    hasKey: false,
    capabilities: [...t.capabilities],
    models: [...t.models],
    viaWorker: false,
    ...(t.extra ? { extra: { ...t.extra } } : {}),
  };
}
function openConn(c?: ProviderConnection) {
  isNew.value = !c;
  editing.value = c ? clone(c) : fromTemplate(CONNECTION_TEMPLATES[0] as ConnectionTemplate);
  keyDraft.value = c && ai.keyOf(c.id) ? KEY_MASK : '';
  modelDraft.value = '';
  resetAdvanced(c);
}
function applyTemplate(t: ConnectionTemplate) {
  if (!editing.value) return;
  const id = editing.value.id;
  editing.value = { ...fromTemplate(t), id };
  resetAdvanced();
}
/** 输入框里的 Key：没改过（还是掩码）就用存着的 */
function currentKey(): string | null {
  const c = editing.value;
  if (!c) return null;
  if (keyDraft.value === KEY_MASK) return ai.keyOf(c.id);
  return keyDraft.value.trim() || null;
}

const MODEL_HINT: Partial<Record<Capability, RegExp>> = {
  embedding: /embed|bge|e5-|gte|m3/i,
  tts: /tts|voice|speech|cosy|sovits|^s1$/i,
  image: /nai-|diffusion|kolors|flux|image|dall-e/i,
};
const NOT_CHAT = /embed|bge|rerank|tts|voice|speech|sensevoice|whisper|kolors|flux|diffusion|nai-|dall-e|image/i;
/** 测试某项能力时用哪个模型：先看分配到这个连接的智能体用的模型，再按名字猜 */
function modelFor(c: ProviderConnection, cap: Capability): string {
  if (cap === 'chat') {
    const fromSlot = API_SLOTS.map((s) => ai.apiSlots[s]).find((x) => x.connectionId === c.id && x.model)?.model;
    if (fromSlot) return fromSlot;
  }
  const fromRoute = ai.routes.find((r) => r.connectionId === c.id && AGENT_META[r.role].capability === cap && r.model && (!isSlotCapability(cap) || c.models.includes(r.model)))?.model;
  if (fromRoute) return fromRoute;
  const hint = MODEL_HINT[cap];
  const guess = hint ? c.models.find((m) => hint.test(m)) : c.models.find((m) => !NOT_CHAT.test(m));
  return guess ?? c.models[0] ?? '';
}
/** 测语音合成时用的音色：哪个角色用这个连接就用谁的，否则用服务商的系统音色 */
function voiceFor(c: ProviderConnection): VoiceSpec | undefined {
  const routeTts = ai.routeOf('tts')?.connectionId;
  const who = chars.list.find((x) => x.voice.connectionId === c.id || (!x.voice.connectionId && routeTts === c.id));
  return who?.voice.voiceId ? voiceSpec(who) : undefined;
}

async function fetchModels() {
  const c = editing.value;
  if (!c) return;
  fetching.value = true;
  try {
    const list = await listModels(ai.endpointOf(c, currentKey()));
    if (!list.length) showToast('没有拉到模型，可以在下面手动填');
    else if (c.kind === 'vertex') {
      // 同 math-reader：Vertex 的 API Key 拉不到模型列表（要 OAuth），列出常用的，保留已经填的
      c.models = [...new Set([...c.models, ...list])];
      showToast('Vertex 的 API Key 拉不到模型列表，先列出常用模型；别的模型在下面手动填');
    } else {
      c.models = list;
      showToast(`拉取到 ${list.length} 个模型`);
    }
  } catch (e) {
    showToast({ message: `拉取失败：${errorText(e)}`.slice(0, 140), duration: 3500 });
  } finally {
    fetching.value = false;
  }
}
function addModel() {
  const c = editing.value;
  const m = modelDraft.value.trim();
  if (!c || !m) return;
  if (!c.models.includes(m)) c.models = [...c.models, m];
  modelDraft.value = '';
}
function removeModel(m: string) {
  const c = editing.value;
  if (c) c.models = c.models.filter((x) => x !== m);
}

/** 按这个连接能做的事逐项测：对话发一句话、向量算一句、语音读"你好"、NovelAI 查订阅 */
async function testConn() {
  const c = editing.value;
  if (!c) return;
  const caps = (['chat', 'embedding', 'tts', 'image'] as Capability[]).filter((x) => c.capabilities.includes(x) && kindCan(c.kind, x));
  if (!caps.length) {
    showToast('这个连接还没有能测试的功能');
    return;
  }
  if (!applyAdvanced(c)) return;
  testing.value = true;
  const key = currentKey();
  const lines: string[] = [];
  let ok = true;
  let latency: number | undefined;
  for (const cap of caps) {
    const r = await testConnection(ai.endpointOf(c, key, modelFor(c, cap)), cap, { voice: cap === 'tts' ? voiceFor(c) : undefined });
    latency ??= r.latencyMs;
    ok &&= r.ok;
    lines.push(`${CAP_LABEL[cap]}：${r.message}`);
  }
  c.lastTest = { ok, at: Date.now(), latencyMs: latency, message: lines.join('\n') };
  testing.value = false;
}
function saveConn() {
  const c = editing.value;
  if (!c || !applyAdvanced(c)) return;
  if (!c.name.trim()) c.name = KIND_LABEL[c.kind];
  if (keyDraft.value !== KEY_MASK) ai.setKey(c.id, keyDraft.value.trim() || null);
  ai.saveConnection(c);
  editing.value = null;
  showToast('已保存');
}
async function removeConn() {
  const c = editing.value;
  if (!c) return;
  const ok = await showConfirmDialog({ title: `删除"${c.name}"？`, message: '这台设备上的 Key 也会一起删掉；用它的智能体改回演示模型。' }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  ai.removeConnection(c.id);
  editing.value = null;
}
function toggleCap(cap: Capability) {
  const c = editing.value;
  if (!c) return;
  c.capabilities = c.capabilities.includes(cap) ? c.capabilities.filter((x) => x !== cap) : [...c.capabilities, cap];
}
function setExtra(field: string, value: string) {
  const c = editing.value;
  if (!c) return;
  const extra = { ...(c.extra ?? {}) };
  if (value.trim()) extra[field] = value.trim();
  else delete extra[field];
  c.extra = Object.keys(extra).length ? extra : undefined;
}
const cosyEmotion = computed({
  get: () => editing.value?.extra?.emotion !== 'off',
  set: (on: boolean) => setExtra('emotion', on ? '' : 'off'),
});

// —— 主要 / 次要 / 备用 API（同 math-reader）——
const chatConns = computed(() => ai.connections.filter((c) => kindCan(c.kind, 'chat') && (c.capabilities.includes('chat') || c.capabilities.includes('vision'))));
const slotEditing = ref<{ slot: ApiSlot; connectionId: string | null; model: string } | null>(null);
const slotOpen = computed({ get: () => !!slotEditing.value, set: (v) => !v && (slotEditing.value = null) });
const slotConn = computed(() => ai.byId(slotEditing.value?.connectionId));
const slotFetching = ref(false);
const slotTesting = ref(false);
const slotTest = ref<{ ok: boolean; text: string } | null>(null);

function slotLine(slot: ApiSlot): string {
  const x = ai.apiSlots[slot];
  const c = ai.byId(x.connectionId);
  if (!c) return slot === 'primary' ? '未选择' : '不使用';
  return `${c.name} · ${x.model || '未选模型'}`;
}
/** 这套 API 能不能用：同 math-reader 的"未配置" */
function slotState(slot: ApiSlot): { ok: boolean; text: string } {
  const r = ai.system.router.slotAttempt(slot, 'chat');
  return 'reason' in r ? { ok: false, text: r.reason } : { ok: true, text: '可以用' };
}
function openSlot(slot: ApiSlot) {
  const x = ai.apiSlots[slot];
  slotEditing.value = { slot, connectionId: x.connectionId, model: x.model };
  slotTest.value = null;
}
function pickSlotConn(c: ProviderConnection | null) {
  const e = slotEditing.value;
  if (!e) return;
  e.connectionId = c?.id ?? null;
  if (!c) e.model = '';
  else if (!c.models.includes(e.model)) e.model = c.models.find((m) => !NOT_CHAT.test(m)) ?? '';
  slotTest.value = null;
}
/** 同 math-reader 的"拉取模型"：用这个连接的地址和 Key 拉，拉到的存进连接 */
async function fetchSlotModels() {
  const c = slotConn.value;
  if (!c) return;
  slotFetching.value = true;
  try {
    const list = await listModels(ai.endpointOf(c, ai.keyOf(c.id)));
    if (!list.length) {
      showToast('没有拉到模型，可以在下面手动填');
      return;
    }
    ai.saveConnection({ ...c, models: c.kind === 'vertex' ? [...new Set([...c.models, ...list])] : list });
    showToast(`拉取到 ${list.length} 个模型`);
  } catch (e) {
    showToast({ message: `拉取失败：${errorText(e)}`.slice(0, 140), duration: 3500 });
  } finally {
    slotFetching.value = false;
  }
}
async function testSlot() {
  const e = slotEditing.value;
  const c = slotConn.value;
  if (!e || !c) return;
  if (!e.model.trim()) {
    showToast('先选模型');
    return;
  }
  slotTesting.value = true;
  const r = await testConnection(ai.endpointOf(c, ai.keyOf(c.id), e.model.trim()), 'chat');
  slotTest.value = { ok: r.ok, text: r.ok ? `连接正常 ${r.latencyMs}ms · ${r.message}` : r.message };
  slotTesting.value = false;
}
function saveSlot() {
  const e = slotEditing.value;
  if (!e) return;
  ai.saveApiSlot(e.slot, { connectionId: e.connectionId, model: e.model });
  slotEditing.value = null;
  showToast('已保存');
}
/** 文字类智能体选用哪一套（同 math-reader 的 AI 功能分配） */
const usesSlot = (role: AgentRole) => isSlotCapability(AGENT_META[role].capability);
function setSlot(role: AgentRole, slot: ApiSlot) {
  ai.saveRoute({ ...routeOf(role), slot: slot === 'primary' ? undefined : slot });
  if (routeEditing.value?.role === role) routeEditing.value.slot = slot === 'primary' ? undefined : slot;
}
/** 卡片上写实际用的是哪套（所选的没设置时同 math-reader 改用别的） */
function slotUsed(role: AgentRole): string {
  const s = ai.status(role);
  if (!s.live) return '';
  const a = ai.system.router.attempts(role)[0];
  return a?.slot ? `${API_SLOT_LABEL[a.slot]} · ${a.connection.name} · ${a.endpoint.model}` : '';
}

// —— 智能体分配 ——
const routeEditing = ref<AgentRoute | null>(null);
const routeOpen = computed({ get: () => !!routeEditing.value, set: (v) => !v && (routeEditing.value = null) });
const routeConn = computed(() => ai.byId(routeEditing.value?.connectionId));
const fallbackConn = computed(() => ai.byId(routeEditing.value?.fallbackConnectionId));
const candidates = computed(() => {
  const role = routeEditing.value?.role;
  if (!role) return [];
  const cap = AGENT_META[role].capability;
  return ai.connections.filter((c) => c.capabilities.includes(cap));
});
const temperature = computed({
  get: () => routeEditing.value?.params?.temperature ?? 1,
  set: (t: number) => {
    const r = routeEditing.value;
    if (r) r.params = { ...(r.params ?? {}), temperature: Math.round(t * 100) / 100 };
  },
});
type RouteParams = NonNullable<AgentRoute['params']>;
function setParam<K extends keyof RouteParams>(k: K, v: RouteParams[K] | undefined) {
  const r = routeEditing.value;
  if (!r) return;
  const params: RouteParams = { ...(r.params ?? {}) };
  if (v === undefined) delete params[k];
  else params[k] = v;
  r.params = Object.keys(params).length ? params : undefined;
}
const effort = computed({
  get: (): ReasoningEffort => routeEditing.value?.params?.reasoningEffort ?? 'auto',
  set: (v: ReasoningEffort) => setParam('reasoningEffort', v === 'auto' ? undefined : v),
});
/** 默认跟着流式走（流式时返回思考过程）；关掉就不要 */
const includeReasoning = computed({
  get: () => routeEditing.value?.params?.includeReasoning !== false,
  set: (on: boolean) => setParam('includeReasoning', on ? undefined : false),
});
/** 生图的步数、引导系数：空着用服务商的默认值 */
function setStyleNumber(field: 'steps' | 'scale', value: string) {
  const s = routeEditing.value?.imageStyle;
  if (!s) return;
  const n = Number(value);
  s[field] = value.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
}
function resetStyle() {
  const r = routeEditing.value;
  if (r) r.imageStyle = clone(DEFAULT_IMAGE_STYLE);
}
function openRoute(role: AgentRole) {
  const r = clone(routeOf(role));
  if (role === 'image' && !r.imageStyle) r.imageStyle = clone(DEFAULT_IMAGE_STYLE);
  routeEditing.value = r;
}
function pickConn(c: ProviderConnection) {
  const r = routeEditing.value;
  if (!r) return;
  r.connectionId = c.id;
  if (!c.models.includes(r.model)) r.model = modelFor(c, AGENT_META[r.role].capability);
}
function saveRoute() {
  const r = routeEditing.value;
  if (!r) return;
  r.model = r.model.trim();
  ai.saveRoute(r);
  routeEditing.value = null;
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
const simLoading = ref(false);
async function runSim() {
  simLoading.value = true;
  try {
    const [a, b] = await services.embedding.embed([simA.value, simB.value]);
    simResult.value = a && b ? cosine(a, b) : null;
  } catch (e) {
    showToast({ message: `向量化失败：${errorText(e)}`.slice(0, 140), duration: 3500 });
  } finally {
    simLoading.value = false;
  }
}
const reindex = ref<{ done: number; total: number } | null>(null);
async function runReindex() {
  const list = memories.filter((m) => m.status !== 'superseded');
  const total = list.length;
  reindex.value = { done: 0, total };
  try {
    for (let i = 0; i < total; i += 16) {
      const batch = list.slice(i, i + 16);
      const vectors = await services.embedding.embed(batch.map((m) => m.content));
      if (services.embedding.live) {
        batch.forEach((m, j) => {
          const v = vectors[j];
          if (v) m.vector = { model: services.embedding.model, dims: v.length, data: encodeVector(v) };
        });
      }
      reindex.value = { done: Math.min(total, i + batch.length), total };
    }
    showToast(services.embedding.live ? `已用 ${services.embedding.model} 重算 ${total} 条记忆` : `演示：重算了 ${total} 条记忆（假向量）`);
  } catch (e) {
    showToast({ message: `重算失败：${errorText(e)}`.slice(0, 140), duration: 3500 });
  } finally {
    setTimeout(() => (reindex.value = null), 1200);
  }
}
</script>

<template>
  <div class="page" data-page="api">
    <PageHeader title="API 与智能体" subtitle="连接 = 地址 + Key；智能体 = 一项工作用哪个连接" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">主要 / 次要 / 备用 API</div>
      <div class="px-4 grid gap-2">
        <button v-for="slot in API_SLOTS" :key="slot" class="agent flex items-center gap-3 w-full text-left press" :data-slot="slot" @click="openSlot(slot)">
          <span class="agent-icon"><span :class="slot === 'primary' ? 'i-lucide-star' : slot === 'secondary' ? 'i-lucide-layers' : 'i-lucide-life-buoy'" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[14.5px] font-600">{{ API_SLOT_LABEL[slot] }}</div>
            <div class="text-[12.5px] text-ink-2 truncate">{{ slotLine(slot) }}</div>
            <div v-if="ai.apiSlots[slot].connectionId || slot === 'primary'" class="live-line" :class="slotState(slot).ok ? 'on' : 'off'">{{ slotState(slot).text }}</div>
          </div>
          <span class="i-lucide-chevron-right text-ink-3" />
        </button>
      </div>
      <p class="note">同 math-reader：对话、番外、总结、生图提示词、主动消息、视觉默认用主要 API；每个可以在下面改用次要或备用。所选的没设置时依次用主要、备用、次要；调用失败时改用备用 API（所选的是备用时改用主要 API）。</p>

      <div class="group-title">连接<button class="action" @click="openConn()"><span class="i-lucide-plus" />添加</button></div>
      <div class="px-4 grid gap-2.5">
        <button v-for="c in ai.connections" :key="c.id" class="conn press" @click="openConn(c)">
          <div class="flex items-center gap-2">
            <span class="status" :class="c.lastTest ? (c.lastTest.ok ? 'ok' : 'bad') : 'idle'" />
            <span class="text-[15px] font-600 truncate">{{ c.name }}</span>
            <span class="tag">{{ KIND_LABEL[c.kind] }}</span>
            <span v-if="c.viaWorker" class="tag accent"><span class="i-lucide-route" />经 Worker</span>
            <span class="ml-auto num text-[12px] shrink-0" :class="c.lastTest?.ok ? 'text-good' : 'text-bad'">
              {{ c.lastTest ? (c.lastTest.ok ? `${c.lastTest.latencyMs}ms` : '失败') : '' }}
            </span>
          </div>
          <div class="text-[12px] text-ink-3 truncate mt-1 text-left">{{ c.baseUrl }}</div>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <span v-for="cap in c.capabilities" :key="cap" class="tag">{{ CAP_LABEL[cap] }}</span>
            <span v-if="c.keyStorage === 'none'" class="tag"><span class="i-lucide-key-round" />无需 Key</span>
            <span v-else-if="c.hasKey" class="tag good"><span class="i-lucide-key-round" />Key 在本机</span>
            <span v-else class="tag warn"><span class="i-lucide-key-round" />未填 Key</span>
          </div>
          <div v-if="c.lastTest && !c.lastTest.ok" class="text-[12px] text-bad mt-1.5 text-left whitespace-pre-wrap break-all">{{ c.lastTest.message }}</div>
        </button>
      </div>
      <p class="note">Key 只存在这台设备的本机数据库里，不进同步数据。没填 Key 的连接不会被调用，用它的智能体继续用演示模型。</p>

      <div class="group-title">智能体分配</div>
      <div class="px-4 grid gap-2">
        <div v-for="role in ROLES" :key="role" class="agent" :data-role="role">
          <button class="flex items-center gap-3 w-full text-left" @click="openRoute(role)">
            <span class="agent-icon"><span :class="AGENT_META[role].icon" /></span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-[14.5px] font-600">{{ AGENT_META[role].label }}</span>
                <span class="tag">{{ RUNS_LABEL[routeOf(role).runsOn] }}</span>
              </div>
              <template v-if="usesSlot(role)">
                <div class="text-[12.5px] text-ink-2 truncate">用{{ API_SLOT_LABEL[routeOf(role).slot ?? 'primary'] }}</div>
              </template>
              <template v-else>
                <div class="text-[12.5px] text-ink-2 truncate">{{ connName(routeOf(role).connectionId) }} · {{ routeOf(role).model || '未选模型' }}</div>
                <div v-if="routeOf(role).fallbackConnectionId" class="text-[11.5px] text-ink-3 truncate">
                  失败时改用 {{ connName(routeOf(role).fallbackConnectionId) }}{{ routeOf(role).fallbackModel ? ` · ${routeOf(role).fallbackModel}` : '' }}
                </div>
              </template>
              <div class="live-line" :class="ai.status(role).live ? 'on' : 'off'">
                <template v-if="ai.status(role).live">已接通{{ usesSlot(role) ? ` · ${slotUsed(role)}` : '' }}</template>
                <template v-else>演示模型 · {{ (ai.status(role) as { reason: string }).reason }}</template>
              </div>
            </div>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
          <div v-if="usesSlot(role)" class="slot-seg mt-2 ml-[48px]">
            <button
              v-for="s in API_SLOTS"
              :key="s"
              type="button"
              class="slot-seg-btn"
              :class="{ on: (routeOf(role).slot ?? 'primary') === s }"
              :aria-pressed="(routeOf(role).slot ?? 'primary') === s"
              @click="setSlot(role, s)"
            >
              {{ API_SLOT_LABEL[s].replace(' API', '') }}
            </button>
          </div>
          <div v-if="role === 'embedding'" class="embed-tools">
            <span class="text-[12px] text-ink-3 num">
              {{ services.embedding.live ? `${services.embedding.model} · ${services.embedding.dims || '—'} 维` : '演示用假向量' }} · {{ memories.length }} 条记忆 · 检索在本机
            </span>
            <div class="flex gap-2 mt-2">
              <van-button size="small" round @click="simOpen = true">测试相似度</van-button>
              <van-button size="small" round :loading="!!reindex" loading-text="重算中" @click="runReindex">用新模型重算全部向量</van-button>
            </div>
            <van-progress v-if="reindex" class="mt-2" :percentage="Math.round((reindex.done / Math.max(1, reindex.total)) * 100)" stroke-width="5" />
          </div>
        </div>
      </div>
      <p class="note">文字类智能体选用主要 / 次要 / 备用 API（同 math-reader 的 AI 功能分配）。语音合成、生图、向量化单独选连接和模型，并设一个备用连接；向量化只会换到同一个模型的备用连接：不同模型的向量不能互相比较，换了模型要重算向量。</p>

      <div class="group-title">回复修剪</div>
      <div class="px-4">
        <button class="agent flex items-center gap-3 w-full text-left press" @click="openFilters">
          <span class="agent-icon"><span class="i-lucide-scissors" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[14.5px] font-600">{{ ai.outputFilters.length ? `${ai.outputFilters.length} 条规则` : '不修剪' }}</div>
            <div class="text-[12.5px] text-ink-2 truncate">所有文本智能体的回复先过一遍这些正则</div>
          </div>
          <span class="i-lucide-chevron-right text-ink-3" />
        </button>
      </div>
      <p class="note">默认去掉漏出来的思考内容：&lt;think&gt;…&lt;/think&gt;、只剩结束标签的半截思考、&lt;!-- consider: … --&gt; 注释（同 SleepTogether）。</p>
    </div>

    <!-- 连接编辑 -->
    <van-popup v-model:show="editOpen" position="bottom" round :style="{ maxHeight: '90%' }">
      <div v-if="editing" class="sheet">
        <div class="sheet-title">{{ isNew ? '添加连接' : editing.name }}</div>
        <template v-if="isNew">
          <label class="field-label">从模板开始</label>
          <div class="flex flex-wrap gap-2">
            <button v-for="t in CONNECTION_TEMPLATES" :key="t.label" class="opt" :class="{ on: editing.name === t.name && editing.baseUrl === t.baseUrl }" @click="applyTemplate(t)">{{ t.label }}</button>
          </div>
        </template>
        <label class="field-label">协议</label>
        <div class="flex flex-wrap gap-2">
          <button v-for="(label, k) in KIND_LABEL" :key="k" class="opt" :class="{ on: editing.kind === k }" @click="editing.kind = k as ConnectionKind">{{ label }}</button>
        </div>
        <label class="field-label" for="conn-name">名称</label>
        <input id="conn-name" v-model="editing.name" class="input" />
        <label class="field-label" for="conn-url">Base URL（中转站填它给你的地址）</label>
        <input id="conn-url" v-model="editing.baseUrl" class="input" inputmode="url" autocomplete="off" />
        <p v-if="editing.kind === 'novelai'" class="text-[12px] text-ink-3 mt-1.5 mb-0">官方填 https://image.novelai.net；公益站、反代填它给的地址，Key 填它给的 Token。</p>
        <template v-if="editing.keyStorage !== 'none'">
          <label class="field-label" for="conn-key">Key{{ KEY_HINT[editing.kind] ?? '' }}</label>
          <input id="conn-key" v-model="keyDraft" class="input" type="password" :placeholder="KEY_PLACEHOLDER[editing.kind] ?? 'sk-…'" autocomplete="off" @focus="keyDraft === KEY_MASK && (keyDraft = '')" />
          <p v-if="editing.kind === 'vertex'" class="text-[12px] text-ink-3 mt-1.5 mb-0">
            API Key（express 模式或绑定服务账号的 Key，同 math-reader）只能调 Gemini；要调 DeepSeek 等开源模型，粘贴整个服务账号 JSON（官方的 OpenAI 兼容接口只认 Google Cloud 授权）。
          </p>
        </template>
        <label class="field-label">Key 存在哪里</label>
        <Segmented
          v-model="editing.keyStorage"
          :options="[
            { value: 'device', label: '只在本机' },
            { value: 'hub', label: '交给 Worker' },
            { value: 'none', label: '不需要' },
          ]"
        />
        <template v-if="editing.kind === 'minimax'">
          <label class="field-label" for="conn-group">GroupId（老账号需要，新账号可以不填）</label>
          <input id="conn-group" :value="editing.extra?.groupId ?? ''" class="input" @input="setExtra('groupId', ($event.target as HTMLInputElement).value)" />
        </template>
        <template v-if="editing.kind === 'vertex'">
          <label class="field-label" for="conn-location">地区（只在用服务账号时用；空着用 global）</label>
          <input id="conn-location" :value="editing.extra?.location ?? ''" class="input" placeholder="global" autocomplete="off" @input="setExtra('location', ($event.target as HTMLInputElement).value)" />
          <label class="field-label" for="conn-project">项目 ID（服务账号 JSON 里有就不用填）</label>
          <input id="conn-project" :value="editing.extra?.projectId ?? ''" class="input" autocomplete="off" @input="setExtra('projectId', ($event.target as HTMLInputElement).value)" />
        </template>
        <template v-if="editing.kind === 'volcengine'">
          <label class="field-label" for="conn-appid">APP ID（火山引擎控制台 → 豆包语音 → 应用管理）</label>
          <input id="conn-appid" :value="editing.extra?.appId ?? ''" class="input" inputmode="numeric" autocomplete="off" @input="setExtra('appId', ($event.target as HTMLInputElement).value)" />
          <label class="field-label" for="conn-resource">Resource ID（空着用 seed-tts-2.0；复刻的 S_ 音色自动用 seed-icl-2.0）</label>
          <input
            id="conn-resource"
            :value="editing.extra?.resourceId ?? ''"
            class="input"
            placeholder="seed-tts-2.0"
            autocomplete="off"
            @input="setExtra('resourceId', ($event.target as HTMLInputElement).value)"
          />
        </template>
        <template v-if="editing.kind === 'workers-ai'">
          <label class="field-label" for="conn-account">Cloudflare 账号 ID（直连 REST 时用；经自己的 Worker 时不需要）</label>
          <input id="conn-account" :value="editing.extra?.accountId ?? ''" class="input" @input="setExtra('accountId', ($event.target as HTMLInputElement).value)" />
        </template>
        <label class="field-label">这个连接能做什么</label>
        <div class="flex flex-wrap gap-2">
          <button v-for="(label, cap) in CAP_LABEL" :key="cap" class="opt" :class="{ on: editing.capabilities.includes(cap) }" @click="toggleCap(cap)">{{ label }}</button>
        </div>
        <div v-if="editing.kind === 'openai' && editing.capabilities.includes('tts')" class="flex items-center justify-between mt-3">
          <div>
            <div class="text-[14px]">CosyVoice 情绪指令</div>
            <div class="text-[12px] text-ink-3">按她的表情加"请用害羞的语气说"；指令被读出来时关掉</div>
          </div>
          <van-switch class="shrink-0" v-model="cosyEmotion" size="22px" />
        </div>
        <div class="flex items-center justify-between gap-3 mt-3">
          <div>
            <div class="text-[14px]">经 Worker 转发</div>
            <div class="text-[12px] text-ink-3">对方不允许浏览器直连（CORS）时打开；要先连上自己的 Worker</div>
          </div>
          <van-switch class="shrink-0" v-model="editing.viaWorker" size="22px" />
        </div>
        <label class="field-label">模型 <button class="text-accent-ink ml-2" @click="fetchModels">{{ fetching ? '拉取中…' : '拉取模型列表' }}</button></label>
        <div class="flex flex-wrap gap-1.5 max-h-[120px] overflow-y-auto">
          <button v-for="m in editing.models" :key="m" class="tag model" @click="removeModel(m)">{{ m }}<span class="i-lucide-x text-[11px]" /></button>
          <span v-if="!editing.models.length" class="text-[12px] text-ink-3">还没有，点"拉取模型列表"，或在下面手动填</span>
        </div>
        <div class="flex gap-2 mt-2">
          <input v-model="modelDraft" class="input flex-1" placeholder="手动添加模型名" autocomplete="off" @keydown.enter="addModel" />
          <van-button size="small" round @click="addModel">添加</van-button>
        </div>
        <template v-if="(editing.kind === 'openai' || editing.kind === 'deepseek') && editing.capabilities.includes('chat')">
          <button class="adv-toggle" @click="advancedOpen = !advancedOpen">
            <span>高级：消息整理、请求参数</span>
            <span :class="advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
          </button>
          <template v-if="advancedOpen">
            <label class="field-label">发出去之前怎么整理消息</label>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="p in PROCESSING"
                :key="p.value"
                class="opt"
                :class="{ on: (editing.promptProcessing ?? 'none') === p.value }"
                @click="editing.promptProcessing = p.value === 'none' ? undefined : p.value"
              >
                {{ p.label }}
              </button>
            </div>
            <p class="text-[12px] text-ink-3 mt-1.5 mb-0">{{ processingHint }}</p>
            <label class="field-label" for="conn-include">额外请求参数（JSON，并进每次的请求体）</label>
            <textarea id="conn-include" v-model="includeDraft" class="textarea mono" rows="3" placeholder='{"top_k": 40}' spellcheck="false" />
            <p v-if="includeError" class="text-[12px] text-bad mt-1 mb-0">{{ includeError }}</p>
            <label class="field-label" for="conn-exclude">去掉的请求参数（逗号隔开，例如中转不认的字段）</label>
            <input id="conn-exclude" v-model="excludeDraft" class="input" placeholder="presence_penalty, frequency_penalty" autocomplete="off" spellcheck="false" />
          </template>
        </template>
        <div v-if="editing.lastTest" class="test-result" :class="editing.lastTest.ok ? 'ok' : 'bad'">{{ editing.lastTest.message }}</div>
        <div class="flex gap-2.5 mt-4">
          <van-button round block :loading="testing" loading-text="测试中" @click="testConn">
            {{ editing.lastTest ? (editing.lastTest.ok ? `连接正常 ${editing.lastTest.latencyMs}ms` : '重新测试') : '测试连接' }}
          </van-button>
          <van-button round block type="primary" @click="saveConn">保存</van-button>
        </div>
        <van-button v-if="!isNew" round block plain type="danger" class="!mt-2.5" @click="removeConn">删除这个连接</van-button>
      </div>
    </van-popup>

    <!-- 智能体分配编辑 -->
    <van-popup v-model:show="routeOpen" position="bottom" round :style="{ maxHeight: '90%' }">
      <div v-if="routeEditing" class="sheet">
        <div class="sheet-title">{{ AGENT_META[routeEditing.role].label }}</div>
        <div class="text-[12.5px] text-ink-3 mt-0.5">{{ AGENT_META[routeEditing.role].desc }}</div>
        <template v-if="usesSlot(routeEditing.role)">
          <label class="field-label">用哪套 API</label>
          <div class="slot-seg">
            <button
              v-for="s in API_SLOTS"
              :key="s"
              type="button"
              class="slot-seg-btn"
              :class="{ on: (routeEditing.slot ?? 'primary') === s }"
              @click="routeEditing.slot = s === 'primary' ? undefined : s"
            >
              {{ API_SLOT_LABEL[s].replace(' API', '') }}
            </button>
          </div>
          <p class="text-[12px] text-ink-3 mt-1.5 mb-0">连接和模型在页面最上面的主要 / 次要 / 备用 API 里选。</p>
        </template>
        <template v-else>
        <label class="field-label">用哪个连接（只列出能做"{{ CAP_LABEL[AGENT_META[routeEditing.role].capability] }}"的）</label>
        <div class="grid gap-1.5">
          <button v-for="c in candidates" :key="c.id" class="pick" :class="{ on: routeEditing.connectionId === c.id }" @click="pickConn(c)">
            <span class="flex-1 text-left truncate">{{ c.name }}</span>
            <span class="text-[12px] shrink-0" :class="c.hasKey || c.keyStorage === 'none' ? 'text-ink-3' : 'text-warn'">{{ c.hasKey || c.keyStorage === 'none' ? KIND_LABEL[c.kind] : '未填 Key' }}</span>
          </button>
          <span v-if="!candidates.length" class="text-[12px] text-ink-3">还没有能做这件事的连接：先在上面添加一个，并勾上"{{ CAP_LABEL[AGENT_META[routeEditing.role].capability] }}"</span>
        </div>
        <label class="field-label" for="route-model">模型</label>
        <div class="flex flex-wrap gap-1.5 max-h-[112px] overflow-y-auto">
          <button v-for="m in routeConn?.models ?? []" :key="m" class="opt" :class="{ on: routeEditing.model === m }" @click="routeEditing.model = m">{{ m }}</button>
        </div>
        <input id="route-model" v-model="routeEditing.model" class="input mt-2" placeholder="或者直接填模型名" autocomplete="off" />
        </template>
        <template v-if="AGENT_META[routeEditing.role].capability === 'chat' && routeEditing.role !== 'main'">
          <label class="field-label">温度 {{ temperature.toFixed(2) }}（越高越有想象力）</label>
          <van-slider v-model="temperature" :min="0" :max="1.5" :step="0.05" bar-height="4px" button-size="16px" />
        </template>
        <p v-if="routeEditing.role === 'main'" class="text-[12px] text-ink-3 mt-2 mb-0">主对话的温度、回复长度等参数以聊天用的预设为准。</p>
        <template v-if="AGENT_META[routeEditing.role].capability === 'chat'">
          <label class="field-label">推理强度（模型支持思考时）</label>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="e in EFFORTS" :key="e.value" class="opt" :class="{ on: effort === e.value }" @click="effort = e.value">{{ e.label }}</button>
          </div>
          <p class="text-[12px] text-ink-3 mt-1.5 mb-0">
            按各家换算：OpenAI 的 reasoning_effort、Claude 的思考预算、Gemini 的思考预算或等级、DeepSeek 的思考开关。"关闭"在 DeepSeek 上关掉思考模式（默认是开的），回复更快。{{
              routeEditing.role === 'main' ? '预设里设了推理强度时以预设为准。' : ''
            }}
          </p>
          <div class="flex items-center justify-between gap-3 mt-3">
            <div>
              <div class="text-[14px]">返回思考过程</div>
              <div class="text-[12px] text-ink-3">流式时一起返回，消息上可以展开看；关掉省流量</div>
            </div>
            <van-switch class="shrink-0" v-model="includeReasoning" size="22px" />
          </div>
        </template>
        <template v-if="routeEditing.role === 'image' && routeEditing.imageStyle">
          <label class="field-label" for="style-prefix">固定前缀（画风、质量词；写 {prompt} 可以指定提示词放在哪）</label>
          <textarea id="style-prefix" v-model="routeEditing.imageStyle.prefix" class="textarea" rows="2" spellcheck="false" />
          <label class="field-label" for="style-suffix">固定后缀</label>
          <input id="style-suffix" v-model="routeEditing.imageStyle.suffix" class="input" autocomplete="off" spellcheck="false" />
          <label class="field-label" for="style-negative">固定负面词</label>
          <textarea id="style-negative" v-model="routeEditing.imageStyle.negative" class="textarea" rows="3" spellcheck="false" />
          <template v-if="routeConn?.kind === 'novelai'">
            <div class="flex items-center justify-between gap-3 mt-3">
              <div>
                <div class="text-[14px]">追加官网的质量词</div>
                <div class="text-[12px] text-ink-3">同 NovelAI 网页版的 Add Quality Tags 和负面预设；前缀里写了质量词就关着</div>
              </div>
              <van-switch class="shrink-0" v-model="routeEditing.imageStyle.naiQuality" size="22px" />
            </div>
            <div class="flex items-center justify-between gap-3 mt-3">
              <div>
                <div class="text-[14px]">Variety Boost</div>
                <div class="text-[12px] text-ink-3">构图、姿势更多样，不容易每张都一样</div>
              </div>
              <van-switch class="shrink-0" :model-value="!!routeEditing.imageStyle.varietyBoost" size="22px" @update:model-value="routeEditing.imageStyle.varietyBoost = $event ? true : undefined" />
            </div>
            <label class="field-label">采样器</label>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="s in NAI_SAMPLERS"
                :key="s"
                class="opt"
                :class="{ on: (routeEditing.imageStyle.sampler ?? NAI_SAMPLERS[0]) === s }"
                @click="routeEditing.imageStyle.sampler = s === NAI_SAMPLERS[0] ? undefined : s"
              >
                {{ s }}
              </button>
            </div>
            <label class="field-label">噪声调度</label>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="s in NAI_SCHEDULES" :key="s" class="opt" :class="{ on: routeEditing.imageStyle.schedule === s }" @click="routeEditing.imageStyle.schedule = routeEditing.imageStyle.schedule === s ? undefined : s">
                {{ s }}
              </button>
            </div>
            <p class="text-[12px] text-ink-3 mt-1.5 mb-0">不选时 V4 用 karras、V3 用 native。</p>
          </template>
          <div v-if="routeConn?.kind === 'novelai' || routeConn?.kind === 'openai'" class="flex gap-2.5">
            <div class="flex-1">
              <label class="field-label" for="style-steps">步数</label>
              <input id="style-steps" class="input" inputmode="numeric" :value="routeEditing.imageStyle.steps ?? ''" :placeholder="routeConn?.kind === 'novelai' ? '28' : '默认'" @input="setStyleNumber('steps', ($event.target as HTMLInputElement).value)" />
            </div>
            <div class="flex-1">
              <label class="field-label" for="style-scale">引导系数</label>
              <input id="style-scale" class="input" inputmode="decimal" :value="routeEditing.imageStyle.scale ?? ''" :placeholder="routeConn?.kind === 'novelai' ? '5' : '默认'" @input="setStyleNumber('scale', ($event.target as HTMLInputElement).value)" />
            </div>
          </div>
          <button class="text-[13px] text-accent-ink mt-2.5" @click="resetStyle">恢复默认风格</button>
        </template>
        <template v-if="!usesSlot(routeEditing.role)">
        <label class="field-label">失败时改用</label>
        <div class="flex flex-wrap gap-1.5">
          <button class="opt" :class="{ on: !routeEditing.fallbackConnectionId }" @click="routeEditing.fallbackConnectionId = null">不用备用</button>
          <button v-for="c in candidates.filter((x) => x.id !== routeEditing?.connectionId)" :key="c.id" class="opt" :class="{ on: routeEditing.fallbackConnectionId === c.id }" @click="(routeEditing.fallbackConnectionId = c.id), (routeEditing.fallbackModel = c.models.includes(routeEditing.model) ? routeEditing.model : modelFor(c, AGENT_META[routeEditing.role].capability))">{{ c.name }}</button>
        </div>
        <template v-if="fallbackConn">
          <label class="field-label">备用连接的模型</label>
          <div class="flex flex-wrap gap-1.5 max-h-[96px] overflow-y-auto">
            <button v-for="m in fallbackConn.models" :key="m" class="opt" :class="{ on: routeEditing.fallbackModel === m }" @click="routeEditing.fallbackModel = m">{{ m }}</button>
          </div>
        </template>
        </template>
        <template v-if="BUDGETED.has(routeEditing.role)">
          <label class="field-label" for="route-budget">每天最多用多少 token（空着不限）</label>
          <input
            id="route-budget"
            class="input"
            inputmode="numeric"
            :value="routeEditing.dailyTokenBudget ?? ''"
            placeholder="例如 100000"
            @input="routeEditing.dailyTokenBudget = Number(($event.target as HTMLInputElement).value.replace(/\D/g, '')) || undefined"
          />
          <p class="text-[12px] text-ink-3 mt-1.5 mb-0 num">今天已用 {{ ai.system.usedToday(routeEditing.role) }}</p>
        </template>
        <label class="field-label">在哪里运行</label>
        <Segmented
          v-model="routeEditing.runsOn"
          :options="[
            { value: 'device', label: '本机' },
            { value: 'auto', label: '自动' },
            { value: 'hub', label: 'Worker' },
          ]"
        />
        <p class="text-[12px] text-ink-3 mt-2 mb-0">选"Worker"或"自动"时，App 关着也能跑，但这个连接的 Key 要交给 Worker（M2 做好同步后可用）。</p>
        <van-button round block type="primary" class="!mt-4" @click="saveRoute">保存</van-button>
      </div>
    </van-popup>

    <!-- 主要 / 次要 / 备用 API -->
    <van-popup v-model:show="slotOpen" position="bottom" round :style="{ maxHeight: '90%' }">
      <div v-if="slotEditing" class="sheet">
        <div class="sheet-title">{{ API_SLOT_LABEL[slotEditing.slot] }}</div>
        <div class="text-[12.5px] text-ink-3 mt-0.5">{{ slotEditing.slot === 'backup' ? '所选 API 调用失败时使用' : slotEditing.slot === 'secondary' ? '在下面的智能体里按功能选用' : '文字类智能体默认用它' }}</div>
        <label class="field-label">用哪个连接（地址和 Key 在连接里填）</label>
        <div class="grid gap-1.5">
          <button v-if="slotEditing.slot !== 'primary'" class="pick" :class="{ on: !slotEditing.connectionId }" @click="pickSlotConn(null)">
            <span class="flex-1 text-left">不使用{{ slotEditing.slot === 'backup' ? '备用' : '次要' }}</span>
          </button>
          <button v-for="c in chatConns" :key="c.id" class="pick" :class="{ on: slotEditing.connectionId === c.id }" @click="pickSlotConn(c)">
            <span class="flex-1 text-left truncate">{{ c.name }}</span>
            <span class="text-[12px] shrink-0" :class="c.hasKey || c.keyStorage === 'none' ? 'text-ink-3' : 'text-warn'">{{ c.hasKey || c.keyStorage === 'none' ? KIND_LABEL[c.kind] : '未填 Key' }}</span>
          </button>
          <span v-if="!chatConns.length" class="text-[12px] text-ink-3">还没有能对话的连接：先在下面"连接"里添加一个</span>
        </div>
        <template v-if="slotConn">
          <label class="field-label" for="slot-model">模型 <button class="text-accent-ink ml-2" @click="fetchSlotModels">{{ slotFetching ? '拉取中…' : '拉取模型列表' }}</button></label>
          <div class="flex flex-wrap gap-1.5 max-h-[112px] overflow-y-auto">
            <button v-for="m in slotConn.models" :key="m" class="opt" :class="{ on: slotEditing.model === m }" @click="slotEditing.model = m">{{ m }}</button>
          </div>
          <input id="slot-model" v-model="slotEditing.model" class="input mt-2" placeholder="或者直接填模型名" autocomplete="off" spellcheck="false" />
          <div v-if="slotTest" class="test-result" :class="slotTest.ok ? 'ok' : 'bad'">{{ slotTest.text }}</div>
        </template>
        <div class="flex gap-2.5 mt-4">
          <van-button v-if="slotConn" round block :loading="slotTesting" loading-text="测试中" @click="testSlot">测试连接</van-button>
          <van-button round block type="primary" @click="saveSlot">保存</van-button>
        </div>
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
          <span class="text-[12px] text-ink-3">{{ services.embedding.live ? `（${services.embedding.model}）` : '（演示用假向量；给"向量化"分配连接并填 Key 后用真模型）' }}</span>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.conn {
  display: block;
  width: 100%;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status.ok {
  background: var(--good);
}
.status.bad {
  background: var(--bad);
}
.status.idle {
  background: var(--ink-3);
}
.tag.good {
  color: var(--good);
}
.tag.model {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.agent {
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.agent-icon {
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
.slot-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 10px;
  background: var(--panel);
}
.slot-seg-btn {
  height: 28px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--ink-2);
}
.slot-seg-btn.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
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
.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 14px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 14px;
  min-width: 0;
}
.pick.on {
  outline: 1.5px solid var(--accent);
  background: var(--accent-soft);
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
.test-result {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.test-result.ok {
  color: var(--ink-2);
}
.test-result.bad {
  color: var(--bad);
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
