import {
  AgentSystem,
  DEFAULT_IMAGE_STYLE,
  DEFAULT_OUTPUT_FILTERS,
  DEFAULT_TTS_TEXT,
  isDeepSeekOfficial,
  isLocalUrl,
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
import { agentRoutes as seedRoutes, CLAUDE_DEFAULT, OPENAI_DEFAULT, RETIRED_SEEDS, connections as seedConnections } from '@/mock/api';

const ROLES = Object.keys(AGENT_META) as AgentRole[];
/** 用对话能力的智能体（主对话、番外、总结、生图提示词、主动消息、视觉） */
const TEXT_ROLES = ROLES.filter((r) => AGENT_META[r].capability === 'chat' || AGENT_META[r].capability === 'vision');

/** 自带连接的版本：2 起有 Claude、OpenAI、本机（Termux），去掉了示例中转和 Workers AI */
const SEED_VERSION = 2;
const NEW_SEEDS = ['conn-claude', 'conn-openai', 'conn-local'];

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
 * 以前存的设置升级到这一版的自带连接（只做一次，删掉的不会再加回来）：
 * - 加上 Claude、OpenAI、本机（Termux 8787），排在最前面；
 * - 去掉地址没改过的示例中转和 Workers AI；用它们的对话智能体改用 Claude（失败时 OpenAI），其余改成"未选择"。
 * 你自己加的连接、已经分配好的智能体不动
 */
function migrateSeeds(conns: ProviderConnection[], routes: AgentRoute[]): ProviderConnection[] {
  const removed = new Set(RETIRED_SEEDS.filter((r) => conns.some((c) => c.id === r.id && c.baseUrl === r.baseUrl)).map((r) => r.id));
  const kept = conns.filter((c) => !removed.has(c.id));
  const added = NEW_SEEDS.filter((id) => !kept.some((c) => c.id === id))
    .map((id) => seedConnections.find((c) => c.id === id))
    .filter((c): c is ProviderConnection => !!c)
    .map((c) => ({ ...clone(c), createdAt: Date.now(), updatedAt: Date.now() }));
  const result = [...added, ...kept];
  const has = (id: string) => result.some((c) => c.id === id);
  for (const r of routes) {
    const text = TEXT_ROLES.includes(r.role);
    if (r.connectionId && removed.has(r.connectionId)) {
      r.connectionId = text && has('conn-claude') ? 'conn-claude' : null;
      r.model = r.connectionId ? CLAUDE_DEFAULT : '';
    }
    if (r.fallbackConnectionId && removed.has(r.fallbackConnectionId)) {
      r.fallbackConnectionId = text && has('conn-openai') && r.connectionId !== 'conn-openai' ? 'conn-openai' : null;
      r.fallbackModel = r.fallbackConnectionId ? OPENAI_DEFAULT : undefined;
    }
  }
  return result;
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
      { key: 'seedVersion', value: SEED_VERSION },
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
    const [savedConns, savedRoutes, savedFilters, savedVersion, secrets] = await Promise.all([
      getOne<ProviderConnection[]>('settings', 'connections'),
      getOne<AgentRoute[]>('settings', 'routes'),
      getOne<string[]>('settings', 'outputFilters'),
      getOne<number>('settings', 'seedVersion'),
      getEntries<string>('secrets'),
    ]);
    if (savedConns?.length) connections.value = savedConns;
    if (savedRoutes?.length) routes.value = completeRoutes(savedRoutes);
    if (savedConns?.length && (savedVersion ?? 1) < SEED_VERSION) connections.value = migrateSeeds(connections.value, routes.value);
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

  /** 这个连接能直接调用：有 Key、不需要 Key，或者是本机 / 局域网地址（Termux 等，不填 Key 也能连） */
  function usable(c: ProviderConnection): boolean {
    return !c.viaWorker && (c.keyStorage === 'none' || !!keys[c.id] || isLocalUrl(c.baseUrl));
  }

  /**
   * 让对话类的智能体（主对话、番外、总结、生图提示词、主动消息、视觉）改用这个连接和模型。
   * onlyIdle：只改还没接通（在用演示模型）的。返回改了的智能体
   */
  function useForText(id: string, model: string, onlyIdle = false): AgentRole[] {
    const c = byId(id);
    if (!c || !model) return [];
    const changed: AgentRole[] = [];
    for (const r of routes.value) {
      if (!TEXT_ROLES.includes(r.role) || !c.capabilities.includes(AGENT_META[r.role].capability)) continue;
      if (onlyIdle && system.status(r.role).live) continue;
      if (r.connectionId === id && r.model === model) continue;
      r.connectionId = id;
      r.model = model;
      if (r.fallbackConnectionId === id) r.fallbackConnectionId = null;
      changed.push(r.role);
    }
    return changed;
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
    usable,
    useForText,
    setOutputFilters,
    status,
    isLive,
    endpointOf,
  };
});
