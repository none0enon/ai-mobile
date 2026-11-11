<script setup lang="ts">
import { encodeVector, errorText, kindCan, listModels, testConnection, type VoiceSpec } from '@app/ai';
import { AGENT_META, type AgentRole, type AgentRoute, type Capability, type ConnectionKind, type KeyStorage, type ProviderConnection } from '@app/shared';
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
 * API 与智能体（参考 math-reader 的"槽位 + 按功能路由"，扩展成"任意个连接 + 每个智能体单独分配"）。
 * 连接 = 一个地址 + Key；智能体 = 一项工作，选用哪个连接、哪个模型、失败时用哪个备用。
 * 连接和分配存在本机，Key 单独存、只在这台设备上。主连接有 Key 的智能体真的调用，其余继续用演示模型。
 */
const ai = useAiStore();
const chars = useCharacterStore();

const KIND_LABEL: Record<ConnectionKind, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Claude',
  gemini: 'Gemini',
  novelai: 'NovelAI',
  minimax: 'MiniMax',
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
}
function applyTemplate(t: ConnectionTemplate) {
  if (!editing.value) return;
  const id = editing.value.id;
  editing.value = { ...fromTemplate(t), id };
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
  const fromRoute = ai.routes.find((r) => r.connectionId === c.id && AGENT_META[r.role].capability === cap && r.model)?.model;
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
    else {
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
  if (!c) return;
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
function openRoute(role: AgentRole) {
  routeEditing.value = clone(routeOf(role));
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
              <div class="text-[12.5px] text-ink-2 truncate">{{ connName(routeOf(role).connectionId) }} · {{ routeOf(role).model || '未选模型' }}</div>
              <div v-if="routeOf(role).fallbackConnectionId" class="text-[11.5px] text-ink-3 truncate">
                失败时改用 {{ connName(routeOf(role).fallbackConnectionId) }}{{ routeOf(role).fallbackModel ? ` · ${routeOf(role).fallbackModel}` : '' }}
              </div>
              <div class="live-line" :class="ai.status(role).live ? 'on' : 'off'">
                <template v-if="ai.status(role).live">已接通</template>
                <template v-else>演示模型 · {{ (ai.status(role) as { reason: string }).reason }}</template>
              </div>
            </div>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
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
      <p class="note">每个智能体单独选连接和模型，并设一个备用连接（主连接失败时自动改用，同 math-reader）。向量化只会换到同一个模型的备用连接：不同模型的向量不能互相比较，换了模型要重算向量。</p>
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
        <template v-if="editing.keyStorage !== 'none'">
          <label class="field-label" for="conn-key">Key{{ editing.kind === 'novelai' ? '（持久 API Token，pst- 开头）' : '' }}</label>
          <input id="conn-key" v-model="keyDraft" class="input" type="password" placeholder="sk-…" autocomplete="off" @focus="keyDraft === KEY_MASK && (keyDraft = '')" />
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
          <van-switch v-model="cosyEmotion" size="22px" />
        </div>
        <div class="flex items-center justify-between mt-3">
          <div>
            <div class="text-[14px]">经 Worker 转发</div>
            <div class="text-[12px] text-ink-3">对方不允许浏览器直连（CORS）时打开；要先连上自己的 Worker</div>
          </div>
          <van-switch v-model="editing.viaWorker" size="22px" />
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
        <template v-if="AGENT_META[routeEditing.role].capability === 'chat' && routeEditing.role !== 'main'">
          <label class="field-label">温度 {{ temperature.toFixed(2) }}（越高越有想象力）</label>
          <van-slider v-model="temperature" :min="0" :max="1.5" :step="0.05" bar-height="4px" button-size="16px" />
        </template>
        <p v-if="routeEditing.role === 'main'" class="text-[12px] text-ink-3 mt-2 mb-0">主对话的温度、回复长度等参数以聊天用的预设为准。</p>
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
