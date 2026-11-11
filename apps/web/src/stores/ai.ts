import {
  AgentSystem,
  DEFAULT_IMAGE_STYLE,
  DEFAULT_OUTPUT_FILTERS,
  DEFAULT_TTS_TEXT,
  isDeepSeekOfficial,
  MemoryAudioCache,
  type AgentConfig,
  type Endpoint,
  type RouteStatus,
} from '@app/ai';
import { AGENT_META, type AgentRole, type AgentRoute, type ProviderConnection } from '@app/shared';
import { defineStore } from 'pinia';
import { showToast } from 'vant';
import { markRaw, reactive, ref } from 'vue';
import { autoSave, getEntries, getOne } from '@/db/idb';
import { agentRoutes as seedRoutes, connections as seedConnections } from '@/mock/api';

const ROLES = Object.keys(AGENT_META) as AgentRole[];

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/**
 * 补齐缺的智能体（以前存的设置里没有后来新加的，例如"番外"），按 AGENT_META 的顺序排；
 * 生图补上默认的生图风格、语音合成补上默认的朗读设置
 */
function completeRoutes(saved: AgentRoute[]): AgentRoute[] {
  return ROLES.map((role) => {
    const r: AgentRoute =
      saved.find((x) => x.role === role) ??
      clone(seedRoutes.find((x) => x.role === role)) ?? { role, connectionId: null, model: '', fallbackConnectionId: null, runsOn: 'device' as const };
    if (role === 'image' && !r.imageStyle) r.imageStyle = clone(DEFAULT_IMAGE_STYLE);
    if (role === 'tts' && !r.ttsText) r.ttsText = clone(DEFAULT_TTS_TEXT);
    return r;
  });
}

const LEGACY_DEEPSEEK = /^deepseek-(?:chat|reasoner)$/;

/**
 * DeepSeek 的旧模型名 deepseek-chat / deepseek-reasoner 已在 2026-07-24 停用（官网更新日志）。
 * 以前存的、地址是 DeepSeek 官方的连接改成 DeepSeek 协议，模型换成 deepseek-flash；
 * 原来用 deepseek-chat（不思考）的智能体把推理强度设成"关闭"，保持原来的快速回复。调用时也会自动换，这里让界面显示对
 */
function migrateDeepSeek(conns: ProviderConnection[], routes: AgentRoute[]) {
  const ids = new Set<string>();
  for (const c of conns) {
    if ((c.kind !== 'openai' && c.kind !== 'deepseek') || !isDeepSeekOfficial(c.baseUrl)) continue;
    ids.add(c.id);
    c.kind = 'deepseek';
    if (c.models.some((m) => LEGACY_DEEPSEEK.test(m))) c.models = [...new Set([...c.models.map((m) => (LEGACY_DEEPSEEK.test(m) ? 'deepseek-flash' : m)), 'deepseek-v4-pro'])];
  }
  for (const r of routes) {
    if (r.connectionId && ids.has(r.connectionId) && LEGACY_DEEPSEEK.test(r.model)) {
      if (r.model === 'deepseek-chat' && !r.params?.reasoningEffort) r.params = { ...(r.params ?? {}), reasoningEffort: 'none' };
      r.model = 'deepseek-flash';
    }
    if (r.fallbackConnectionId && ids.has(r.fallbackConnectionId) && r.fallbackModel && LEGACY_DEEPSEEK.test(r.fallbackModel)) r.fallbackModel = 'deepseek-flash';
  }
}

/**
 * API 连接、智能体分配和 Key（参考 math-reader 的"三套 API + 按功能分配"，扩展成任意个连接 + 每个智能体单独分配）。
 * - 连接和分配存在 settings 表（以后随同步走）；
 * - Key 单独存在 secrets 表，只在这台设备上，永远不进同步数据；
 * - 智能体的主连接有 Key 时真的调用，没有时界面继续用演示模型。
 */
export const useAiStore = defineStore('ai', () => {
  const connections = ref<ProviderConnection[]>(clone(seedConnections));
  const routes = ref<AgentRoute[]>(completeRoutes(clone(seedRoutes)));
  const keys = reactive<Record<string, string>>({});
  /** 输出修剪规则（SleepTogether 的全局正则）：所有文本智能体的回复都过一遍 */
  const outputFilters = ref<string[]>([...DEFAULT_OUTPUT_FILTERS]);

  const settingsSaver = autoSave(
    'settings',
    () => [
      { key: 'connections', value: connections.value },
      { key: 'routes', value: routes.value },
      { key: 'outputFilters', value: outputFilters.value },
    ],
    () => [connections.value, routes.value, outputFilters.value],
  );
  const secretSaver = autoSave(
    'secrets',
    () => Object.entries(keys).filter(([, v]) => !!v).map(([key, value]) => ({ key, value })),
    () => ({ ...keys }),
    200,
  );

  const config: AgentConfig = {
    connections: () => connections.value,
    routes: () => routes.value,
    keyOf: (id) => keys[id] || null,
    // M2：连上自己的 Worker 后，经 /v1/relay 转发（对方不允许浏览器直连、或 Key 交给了 Worker 时用）
    relay: () => null,
  };

  // 换备用连接时提示一下（同 math-reader 的"主要 API 失败，改用备用 API"）
  let lastFailoverToast = 0;
  const system = markRaw(
    new AgentSystem({
      config,
      audioCache: new MemoryAudioCache(64),
      onFailover: (role, from, to) => {
        if (Date.now() - lastFailoverToast < 3000) return;
        lastFailoverToast = Date.now();
        showToast(`${AGENT_META[role].label}：${from.connection.name} 失败，改用 ${to.connection.name}`);
      },
    }),
  );

  function syncHasKey() {
    for (const c of connections.value) {
      const has = !!keys[c.id];
      if (c.hasKey !== has) c.hasKey = has;
    }
  }

  async function hydrate() {
    const [savedConns, savedRoutes, savedFilters, secrets] = await Promise.all([
      getOne<ProviderConnection[]>('settings', 'connections'),
      getOne<AgentRoute[]>('settings', 'routes'),
      getOne<string[]>('settings', 'outputFilters'),
      getEntries<string>('secrets'),
    ]);
    if (savedConns?.length) connections.value = savedConns;
    if (savedRoutes?.length) routes.value = completeRoutes(savedRoutes);
    migrateDeepSeek(connections.value, routes.value);
    if (Array.isArray(savedFilters)) setOutputFilters(savedFilters);
    for (const { key, value } of secrets) if (typeof value === 'string' && value) keys[key] = value;
    syncHasKey();
    settingsSaver.start();
    secretSaver.start();
  }

  function byId(id: string | null | undefined): ProviderConnection | undefined {
    return connections.value.find((c) => c.id === id);
  }

  function routeOf(role: AgentRole): AgentRoute | undefined {
    return routes.value.find((r) => r.role === role);
  }

  function keyOf(id: string): string | null {
    return keys[id] || null;
  }

  function setKey(id: string, key: string | null) {
    const k = key?.trim();
    if (k) keys[id] = k;
    else delete keys[id];
    const c = byId(id);
    if (c) c.hasKey = !!k;
  }

  function saveConnection(c: ProviderConnection) {
    const next = { ...c, updatedAt: Date.now(), hasKey: !!keys[c.id] };
    const i = connections.value.findIndex((x) => x.id === c.id);
    if (i >= 0) connections.value[i] = next;
    else connections.value.push(next);
  }

  /** 删连接：同时删掉它的 Key，分配到它的智能体改成"未选择" */
  function removeConnection(id: string) {
    connections.value = connections.value.filter((c) => c.id !== id);
    delete keys[id];
    for (const r of routes.value) {
      if (r.connectionId === id) r.connectionId = null;
      if (r.fallbackConnectionId === id) r.fallbackConnectionId = null;
    }
  }

  function saveRoute(r: AgentRoute) {
    const i = routes.value.findIndex((x) => x.role === r.role);
    if (i >= 0) routes.value[i] = { ...r };
  }

  function setOutputFilters(patterns: string[]) {
    outputFilters.value = patterns.map((x) => x.trim()).filter(Boolean);
    system.setOutputFilters(outputFilters.value);
  }

  function status(role: AgentRole): RouteStatus {
    return system.status(role);
  }

  function isLive(role: AgentRole): boolean {
    return system.status(role).live;
  }

  /** 用连接 + Key 拼一个端点（测试连接、拉模型列表；连接可能还没保存） */
  function endpointOf(c: ProviderConnection, key: string | null, model = c.models[0] ?? ''): Endpoint {
    return {
      connectionId: c.id,
      name: c.name,
      kind: c.kind,
      baseUrl: c.baseUrl,
      key,
      model,
      headers: c.extraHeaders,
      extra: c.extra,
      promptProcessing: c.promptProcessing,
      includeBody: c.includeBody,
      excludeBody: c.excludeBody,
    };
  }

  return {
    connections,
    routes,
    outputFilters,
    system,
    hydrate,
    byId,
    routeOf,
    keyOf,
    setKey,
    saveConnection,
    removeConnection,
    saveRoute,
    setOutputFilters,
    status,
    isLive,
    endpointOf,
  };
});
