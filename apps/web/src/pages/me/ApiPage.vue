<script setup lang="ts">
import { AGENT_META, type AgentRole, type AgentRoute, type Capability, type KeyStorage, type ProviderConnection } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { agentRoutes, connections } from '@/mock/api';
import { memories } from '@/mock/memories';
import { cosine, services } from '@/services';
import { sleep } from '@/utils/id';

/**
 * API 与智能体（参考 math-reader 的"槽位 + 按功能路由"，扩展成"任意个连接 + 每个智能体单独分配"）。
 * 连接 = 一个地址 + Key；智能体 = 一项工作，选用哪个连接、哪个模型、失败时用哪个备用。
 */
const conns = ref<ProviderConnection[]>(connections.map((c) => ({ ...c })));
const routes = ref<AgentRoute[]>(agentRoutes.map((r) => ({ ...r })));

const KIND_LABEL: Record<string, string> = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', gemini: 'Gemini', novelai: 'NovelAI', 'workers-ai': 'Workers AI' };
const CAP_LABEL: Record<Capability, string> = { chat: '对话', vision: '识图', embedding: '向量', tts: '语音合成', stt: '语音识别', image: '生图' };
const KEY_LABEL: Record<KeyStorage, string> = { device: '只在本机', hub: '交给我的 Worker', none: '无需 Key' };
const RUNS_LABEL = { device: '本机', hub: 'Worker', auto: '自动' } as const;

function connName(id: string | null) {
  return conns.value.find((c) => c.id === id)?.name ?? '未选择';
}

// —— 连接编辑 ——
const editing = ref<ProviderConnection | null>(null);
const editOpen = computed({ get: () => !!editing.value, set: (v) => !v && (editing.value = null) });
const keyDraft = ref('');
const testing = ref(false);
const fetching = ref(false);

function openConn(c?: ProviderConnection) {
  editing.value = c
    ? { ...c, capabilities: [...c.capabilities], models: [...c.models] }
    : { id: `conn-${Date.now()}`, createdAt: Date.now(), updatedAt: Date.now(), name: '新连接', kind: 'openai', baseUrl: 'https://', keyStorage: 'device', hasKey: false, capabilities: ['chat'], models: [], viaWorker: false };
  keyDraft.value = editing.value.hasKey ? '••••••••••••••••' : '';
}
async function fetchModels() {
  if (!editing.value) return;
  fetching.value = true;
  await sleep(700);
  if (!editing.value.models.length) editing.value.models = ['deepseek-chat', 'deepseek-reasoner'];
  fetching.value = false;
  showToast(`拉取到 ${editing.value.models.length} 个模型`);
}
async function testConn() {
  if (!editing.value) return;
  testing.value = true;
  await sleep(800);
  editing.value.lastTest = { ok: true, at: Date.now(), latencyMs: 640 };
  testing.value = false;
}
function saveConn() {
  const c = editing.value;
  if (!c) return;
  c.hasKey = c.keyStorage !== 'none' && keyDraft.value.length > 0;
  const i = conns.value.findIndex((x) => x.id === c.id);
  if (i >= 0) conns.value[i] = c;
  else conns.value.push(c);
  editing.value = null;
  showToast('已保存（演示）');
}
function toggleCap(cap: Capability) {
  const c = editing.value;
  if (!c) return;
  c.capabilities = c.capabilities.includes(cap) ? c.capabilities.filter((x) => x !== cap) : [...c.capabilities, cap];
}

// —— 智能体分配 ——
const routeEditing = ref<AgentRoute | null>(null);
const routeOpen = computed({ get: () => !!routeEditing.value, set: (v) => !v && (routeEditing.value = null) });
const routeConn = computed(() => conns.value.find((c) => c.id === routeEditing.value?.connectionId));
const candidates = computed(() => {
  const role = routeEditing.value?.role;
  if (!role) return [];
  const cap = AGENT_META[role].capability;
  return conns.value.filter((c) => c.capabilities.includes(cap));
});
function openRoute(r: AgentRoute) {
  routeEditing.value = { ...r };
}
function saveRoute() {
  const r = routeEditing.value;
  if (!r) return;
  const i = routes.value.findIndex((x) => x.role === r.role);
  if (i >= 0) routes.value[i] = r;
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
  const [a, b] = await services.embedding.embed([simA.value, simB.value]);
  simResult.value = a && b ? cosine(a, b) : null;
  simLoading.value = false;
}
const reindex = ref<{ done: number; total: number } | null>(null);
async function runReindex() {
  const total = memories.length;
  reindex.value = { done: 0, total };
  for (let i = 1; i <= total; i += 1) {
    await sleep(160);
    reindex.value = { done: i, total };
  }
  showToast(`已用新模型重算 ${total} 条记忆`);
  setTimeout(() => (reindex.value = null), 1200);
}
const ROLES = Object.keys(AGENT_META) as AgentRole[];
</script>

<template>
  <div class="page" data-page="api">
    <PageHeader title="API 与智能体" subtitle="连接 = 地址 + Key；智能体 = 一项工作用哪个连接" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">连接<button class="action" @click="openConn()"><span class="i-lucide-plus" />添加</button></div>
      <div class="px-4 grid gap-2.5">
        <button v-for="c in conns" :key="c.id" class="conn press" @click="openConn(c)">
          <div class="flex items-center gap-2">
            <span class="status" :class="c.lastTest ? (c.lastTest.ok ? 'ok' : 'bad') : 'idle'" />
            <span class="text-[15px] font-600 truncate">{{ c.name }}</span>
            <span class="tag">{{ KIND_LABEL[c.kind] }}</span>
            <span v-if="c.viaWorker" class="tag accent"><span class="i-lucide-route" />经 Worker</span>
            <span class="ml-auto num text-[12px]" :class="c.lastTest?.ok ? 'text-good' : 'text-bad'">
              {{ c.lastTest ? (c.lastTest.ok ? `${c.lastTest.latencyMs}ms` : '失败') : '' }}
            </span>
          </div>
          <div class="text-[12px] text-ink-3 truncate mt-1 text-left">{{ c.baseUrl }}</div>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <span v-for="cap in c.capabilities" :key="cap" class="tag">{{ CAP_LABEL[cap] }}</span>
            <span class="tag" :class="c.keyStorage === 'hub' ? 'warn' : ''"><span class="i-lucide-key-round" />{{ KEY_LABEL[c.keyStorage] }}</span>
          </div>
          <div v-if="c.lastTest && !c.lastTest.ok" class="text-[12px] text-bad mt-1.5 text-left">{{ c.lastTest.message }}</div>
        </button>
      </div>
      <p class="note">Key 默认只存在这台设备，不进同步数据。"交给我的 Worker"的 Key 只能写入、读不回来，后台智能体（主动消息、夜间总结、生图）才能用。</p>

      <div class="group-title">智能体分配</div>
      <div class="px-4 grid gap-2">
        <div v-for="role in ROLES" :key="role" class="agent">
          <button class="flex items-center gap-3 w-full text-left" @click="openRoute(routes.find((r) => r.role === role)!)">
            <span class="agent-icon"><span :class="AGENT_META[role].icon" /></span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-[14.5px] font-600">{{ AGENT_META[role].label }}</span>
                <span class="tag">{{ RUNS_LABEL[routes.find((r) => r.role === role)?.runsOn ?? 'device'] }}</span>
              </div>
              <div class="text-[12.5px] text-ink-2 truncate">
                {{ connName(routes.find((r) => r.role === role)?.connectionId ?? null) }} · {{ routes.find((r) => r.role === role)?.model }}
              </div>
              <div v-if="routes.find((r) => r.role === role)?.fallbackConnectionId" class="text-[11.5px] text-ink-3 truncate">
                失败时改用 {{ connName(routes.find((r) => r.role === role)?.fallbackConnectionId ?? null) }}
              </div>
            </div>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
          <div v-if="role === 'embedding'" class="embed-tools">
            <span class="text-[12px] text-ink-3 num">{{ routes.find((r) => r.role === 'embedding')?.dims }} 维 · {{ memories.length }} 条记忆已向量化 · 检索在本机</span>
            <div class="flex gap-2 mt-2">
              <van-button size="small" round @click="simOpen = true">测试相似度</van-button>
              <van-button size="small" round :loading="!!reindex" loading-text="重算中" @click="runReindex">用新模型重算全部向量</van-button>
            </div>
            <van-progress v-if="reindex" class="mt-2" :percentage="Math.round((reindex.done / reindex.total) * 100)" stroke-width="5" />
          </div>
        </div>
      </div>
      <p class="note">每个智能体都可以单独选连接和模型，并设一个备用连接（主连接失败时自动改用，同 math-reader）。向量化可以选任意 OpenAI 兼容的 /embeddings 接口；换了模型要重算向量，因为不同模型的向量不能互相比较。</p>
    </div>

    <!-- 连接编辑 -->
    <van-popup v-model:show="editOpen" position="bottom" round :style="{ maxHeight: '88%' }">
      <div v-if="editing" class="sheet">
        <div class="sheet-title">{{ editing.name }}</div>
        <label class="field-label">协议</label>
        <div class="flex flex-wrap gap-2">
          <button v-for="(label, k) in KIND_LABEL" :key="k" class="opt" :class="{ on: editing.kind === k }" @click="editing.kind = k as ProviderConnection['kind']">{{ label }}</button>
        </div>
        <label class="field-label" for="conn-name">名称</label>
        <input id="conn-name" v-model="editing.name" class="input" />
        <label class="field-label" for="conn-url">Base URL（中转站填它给你的地址）</label>
        <input id="conn-url" v-model="editing.baseUrl" class="input" inputmode="url" />
        <label class="field-label" for="conn-key">Key</label>
        <input id="conn-key" v-model="keyDraft" class="input" type="password" placeholder="sk-…" autocomplete="off" />
        <label class="field-label">Key 存在哪里</label>
        <Segmented
          v-model="editing.keyStorage"
          :options="[
            { value: 'device', label: '只在本机' },
            { value: 'hub', label: '交给 Worker' },
            { value: 'none', label: '不需要' },
          ]"
        />
        <label class="field-label">这个连接能做什么</label>
        <div class="flex flex-wrap gap-2">
          <button v-for="(label, cap) in CAP_LABEL" :key="cap" class="opt" :class="{ on: editing.capabilities.includes(cap) }" @click="toggleCap(cap)">{{ label }}</button>
        </div>
        <div class="flex items-center justify-between mt-3">
          <div>
            <div class="text-[14px]">经 Worker 转发</div>
            <div class="text-[12px] text-ink-3">对方不允许浏览器直连（CORS）时打开</div>
          </div>
          <van-switch v-model="editing.viaWorker" size="22px" />
        </div>
        <label class="field-label">模型 <button class="text-accent-ink ml-2" @click="fetchModels">{{ fetching ? '拉取中…' : '拉取模型列表' }}</button></label>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="m in editing.models" :key="m" class="tag">{{ m }}</span>
          <span v-if="!editing.models.length" class="text-[12px] text-ink-3">还没有，点"拉取模型列表"</span>
        </div>
        <div class="flex gap-2.5 mt-4">
          <van-button round block :loading="testing" loading-text="测试中" @click="testConn">
            {{ editing.lastTest ? (editing.lastTest.ok ? `连接正常 ${editing.lastTest.latencyMs}ms` : '重新测试') : '测试连接' }}
          </van-button>
          <van-button round block type="primary" @click="saveConn">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 智能体分配编辑 -->
    <van-popup v-model:show="routeOpen" position="bottom" round :style="{ maxHeight: '88%' }">
      <div v-if="routeEditing" class="sheet">
        <div class="sheet-title">{{ AGENT_META[routeEditing.role].label }}</div>
        <div class="text-[12.5px] text-ink-3 mt-0.5">{{ AGENT_META[routeEditing.role].desc }}</div>
        <label class="field-label">用哪个连接（只列出能做"{{ CAP_LABEL[AGENT_META[routeEditing.role].capability] }}"的）</label>
        <div class="grid gap-1.5">
          <button v-for="c in candidates" :key="c.id" class="pick" :class="{ on: routeEditing.connectionId === c.id }" @click="(routeEditing.connectionId = c.id), (routeEditing.model = c.models[0] ?? '')">
            <span class="flex-1 text-left">{{ c.name }}</span><span class="text-[12px] text-ink-3">{{ KIND_LABEL[c.kind] }}</span>
          </button>
        </div>
        <label class="field-label">模型</label>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="m in routeConn?.models ?? []" :key="m" class="opt" :class="{ on: routeEditing.model === m }" @click="routeEditing.model = m">{{ m }}</button>
        </div>
        <label class="field-label">失败时改用</label>
        <div class="flex flex-wrap gap-1.5">
          <button class="opt" :class="{ on: !routeEditing.fallbackConnectionId }" @click="routeEditing.fallbackConnectionId = null">不用备用</button>
          <button v-for="c in candidates.filter((x) => x.id !== routeEditing?.connectionId)" :key="c.id" class="opt" :class="{ on: routeEditing.fallbackConnectionId === c.id }" @click="routeEditing.fallbackConnectionId = c.id">{{ c.name }}</button>
        </div>
        <label class="field-label">在哪里运行</label>
        <Segmented
          v-model="routeEditing.runsOn"
          :options="[
            { value: 'device', label: '本机' },
            { value: 'auto', label: '自动' },
            { value: 'hub', label: 'Worker' },
          ]"
        />
        <p class="text-[12px] text-ink-3 mt-2 mb-0">选"Worker"或"自动"时，App 关着也能跑，但这个连接的 Key 要交给 Worker。</p>
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
          <span class="text-[12px] text-ink-3">（演示用假向量；正式版调你选的 Embedding 接口）</span>
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
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.pick {
  display: flex;
  align-items: center;
  height: 42px;
  padding: 0 14px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 14px;
}
.pick.on {
  outline: 1.5px solid var(--accent);
  background: var(--accent-soft);
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
