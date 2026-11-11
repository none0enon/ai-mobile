import {
  AgentSystem,
  apiLabel,
  channelsFor,
  DEFAULT_IMAGE_STYLE,
  DEFAULT_OUTPUT_FILTERS,
  DEFAULT_TTS_TEXT,
  endpointOfApi,
  errorReport,
  errorText,
  isAbortError,
  MemoryAudioCache,
  type AgentConfig,
  type Endpoint,
  type RouteStatus,
} from '@app/ai';
import {
  AGENT_META,
  apiKeyId,
  isTextRole,
  type AgentRole,
  type AgentRoute,
  type ApiChannel,
  type ConnectionKind,
  type CustomFormat,
  type FeatureApi,
  type PromptProcessing,
} from '@app/shared';
import { defineStore } from 'pinia';
import { showToast } from 'vant';
import { markRaw, reactive, ref } from 'vue';
import { autoSave, getEntries, getOne, write } from '@/db/idb';
import { defaultRoutes } from '@/mock/api';

const ROLES = Object.keys(AGENT_META) as AgentRole[];

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function validApi(x: unknown): FeatureApi | null {
  if (!x || typeof x !== 'object') return null;
  const a = x as Partial<FeatureApi>;
  if (typeof a.channel !== 'string') return null;
  return { ...a, channel: a.channel, baseUrl: typeof a.baseUrl === 'string' ? a.baseUrl : '', model: typeof a.model === 'string' ? a.model : '', models: Array.isArray(a.models) ? a.models.filter((m) => typeof m === 'string') : [] };
}

/** 补齐缺的功能（以前存的设置里没有后来新加的），按 AGENT_META 的顺序排；生图补上默认的生图风格、语音合成补上默认的朗读设置 */
function completeRoutes(saved: Partial<AgentRoute>[]): AgentRoute[] {
  const seeds = defaultRoutes();
  return ROLES.map((role) => {
    const seed = seeds.find((x) => x.role === role) as AgentRoute;
    const s = saved.find((x) => x?.role === role);
    const r: AgentRoute = s ? { ...seed, ...s, role, api: validApi(s.api), backup: validApi(s.backup) } : seed;
    if (role === 'image' && !r.imageStyle) r.imageStyle = clone(DEFAULT_IMAGE_STYLE);
    if (role === 'tts' && !r.ttsText) r.ttsText = clone(DEFAULT_TTS_TEXT);
    return r;
  });
}

// —— 以前的设置（按连接分：连接 + 主要 / 次要 / 备用 API + 智能体分配）：第一次打开新版时转成按功能分的设置 ——

interface LegacyConnection {
  id: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  models?: string[];
  extra?: Record<string, string>;
  extraHeaders?: Record<string, string>;
  promptProcessing?: PromptProcessing;
  includeBody?: Record<string, unknown>;
  excludeBody?: string[];
  deleted?: boolean;
}
type LegacySlot = 'primary' | 'secondary' | 'backup';
interface LegacyRoute extends Partial<AgentRoute> {
  role: AgentRole;
  slot?: LegacySlot;
  connectionId?: string | null;
  model?: string;
  fallbackConnectionId?: string | null;
  fallbackModel?: string;
}
type LegacySlots = Partial<Record<LegacySlot, { connectionId?: string | null; model?: string }>>;

/** 以前的连接在这个功能上对应哪个渠道；用不了的（Workers AI、地图、示例地址）返回 null */
function legacyChannel(c: LegacyConnection, role: AgentRole): { channel: ApiChannel; format?: CustomFormat } | null {
  const text = isTextRole(role);
  let host = '';
  try {
    host = new URL(c.baseUrl).hostname;
  } catch {
    // 地址不完整
  }
  if (/relay-example\.com$/.test(host)) return null;
  let out: { channel: ApiChannel; format?: CustomFormat } | null = null;
  switch (c.kind) {
    case 'anthropic':
    case 'deepseek':
    case 'vertex':
      out = { channel: c.kind };
      break;
    case 'gemini':
      out = !/googleapis\.com$/.test(host) && text ? { channel: 'custom', format: 'gemini' } : { channel: 'gemini' };
      break;
    case 'openai':
      out = text ? { channel: 'openai' } : /siliconflow/.test(host) ? { channel: 'siliconflow' } : { channel: 'custom' };
      break;
    case 'novelai':
    case 'minimax':
    case 'volcengine':
    case 'fish-audio':
    case 'gpt-sovits':
      out = { channel: c.kind };
      break;
    default:
      out = null;
  }
  return out && channelsFor(role).includes(out.channel) ? out : null;
}

function legacyMigrate(
  conns: LegacyConnection[],
  routes: LegacyRoute[],
  slots: LegacySlots | undefined,
  oldKeys: Record<string, string>,
): { routes: AgentRoute[]; keys: Record<string, string> } {
  const keys: Record<string, string> = {};
  const byId = (id: string | null | undefined) => conns.find((c) => c.id === id && !c.deleted);
  const toApi = (role: AgentRole, connId: string | null | undefined, model: string | undefined, backup: boolean): FeatureApi | null => {
    const c = byId(connId);
    if (!c) return null;
    const ch = legacyChannel(c, role);
    if (!ch) return null;
    if (oldKeys[c.id]) keys[apiKeyId(role, backup)] = oldKeys[c.id] as string;
    return {
      channel: ch.channel,
      ...(ch.format ? { format: ch.format } : {}),
      baseUrl: c.baseUrl,
      model: model?.trim() ?? '',
      models: [...(c.models ?? [])],
      ...(c.extra ? { extra: c.extra } : {}),
      ...(c.extraHeaders ? { headers: c.extraHeaders } : {}),
      ...(c.promptProcessing ? { promptProcessing: c.promptProcessing } : {}),
      ...(c.includeBody ? { includeBody: c.includeBody } : {}),
      ...(c.excludeBody ? { excludeBody: c.excludeBody } : {}),
    };
  };
  // 文本功能：以前按 math-reader 的规则选用主要 / 次要 / 备用 API
  const usable = (s: LegacySlot) => {
    const x = slots?.[s];
    return x?.connectionId && byId(x.connectionId) && x.model?.trim() ? (x as { connectionId: string; model: string }) : null;
  };
  const pairOf = (r: LegacyRoute | undefined) => {
    if (slots) {
      const chosen = r?.slot ?? 'primary';
      const own = [...new Set<LegacySlot>([chosen, 'primary', 'backup', 'secondary'])].find((s) => usable(s));
      if (!own) return null;
      const backupSlot: LegacySlot = own === 'backup' ? 'primary' : 'backup';
      return { own: usable(own)!, backup: backupSlot !== own ? usable(backupSlot) : null };
    }
    if (!r?.connectionId) return null;
    return {
      own: { connectionId: r.connectionId, model: r.model ?? '' },
      backup: r.fallbackConnectionId ? { connectionId: r.fallbackConnectionId, model: r.fallbackModel || r.model || '' } : null,
    };
  };
  const mainPair = pairOf(routes.find((r) => r.role === 'main'));
  const seeds = defaultRoutes();
  const out = ROLES.map((role): AgentRoute => {
    const seed = seeds.find((x) => x.role === role) as AgentRoute;
    const r = routes.find((x) => x.role === role);
    const base: AgentRoute = {
      ...seed,
      ...(r?.params ? { params: r.params } : {}),
      ...(r?.runsOn ? { runsOn: r.runsOn } : {}),
      ...(r?.dailyTokenBudget ? { dailyTokenBudget: r.dailyTokenBudget } : {}),
      ...(r?.dims ? { dims: r.dims } : {}),
      ...(r?.extra ? { extra: r.extra } : {}),
      ...(r?.imageStyle ? { imageStyle: r.imageStyle } : {}),
      ...(r?.ttsText ? { ttsText: r.ttsText } : {}),
    };
    if (isTextRole(role)) {
      const pair = role === 'main' ? mainPair : pairOf(r);
      const same = role !== 'main' && (!pair || JSON.stringify(pair) === JSON.stringify(mainPair));
      if (same) return { ...base, sameAsMain: true, api: null, backup: null };
      const api = pair ? toApi(role, pair.own.connectionId, pair.own.model, false) : null;
      const backup = pair?.backup ? toApi(role, pair.backup.connectionId, pair.backup.model, true) : null;
      return { ...base, sameAsMain: role === 'main' ? undefined : false, api, backup };
    }
    if (!r?.connectionId) return base;
    const api = toApi(role, r.connectionId, r.model, false) ?? base.api;
    const backup = r.fallbackConnectionId ? toApi(role, r.fallbackConnectionId, r.fallbackModel || r.model, true) : null;
    return { ...base, api, backup };
  });
  return { routes: completeRoutes(out), keys };
}

/** 设置页显示的"上次调用失败"：一句话 + 完整报错 */
export interface CallError {
  at: number;
  summary: string;
  detail: string;
}

/**
 * API 设置（按功能分）：
 * - 每个功能（主对话、番外、向量化、语音合成、生图……）自己选渠道、填地址、Key、模型，可以再设一个备用 API；
 * - 主对话以外的文本功能可以跟随主对话；
 * - 设置存在 settings 表（以后随同步走）；Key 单独存在 secrets 表，只在这台设备上，永远不进同步数据；
 * - 功能能用时真的调用，不能用时界面继续用演示模型；调用失败的完整报错记在 lastErrors，设置页能看到。
 */
export const useAiStore = defineStore('ai', () => {
  const routes = ref<AgentRoute[]>(completeRoutes([]));
  const keys = reactive<Record<string, string>>({});
  /** 输出修剪规则（SleepTogether 的全局正则）：所有文本功能的回复都过一遍 */
  const outputFilters = ref<string[]>([...DEFAULT_OUTPUT_FILTERS]);
  /** 每个功能上次调用失败的报错（只在内存里）；之后成功了就清掉 */
  const lastErrors = reactive<Partial<Record<AgentRole, CallError>>>({});

  const settingsSaver = autoSave(
    'settings',
    () => [
      { key: 'apiFeatures', value: routes.value },
      { key: 'outputFilters', value: outputFilters.value },
    ],
    () => [routes.value, outputFilters.value],
  );
  const secretSaver = autoSave(
    'secrets',
    () => Object.entries(keys).filter(([, v]) => !!v).map(([key, value]) => ({ key, value })),
    () => ({ ...keys }),
    200,
  );

  const config: AgentConfig = {
    routes: () => routes.value,
    keyOf: (id) => keys[id] || null,
  };

  function noteError(role: AgentRole, e: unknown) {
    lastErrors[role] = { at: Date.now(), summary: errorText(e), detail: errorReport(e) };
  }

  // 换备用 API 时提示一下（同 math-reader 的"主要 API 失败，改用备用 API"）；失败的完整报错记下来，设置页能看到
  let lastFailoverToast = 0;
  const system = markRaw(
    new AgentSystem({
      config,
      audioCache: new MemoryAudioCache(64),
      onFailover: (role, from, to, error) => {
        noteError(role, error);
        if (Date.now() - lastFailoverToast < 3000) return;
        lastFailoverToast = Date.now();
        showToast({ message: `${AGENT_META[role].label}：${from.endpoint.name} 调用失败，改用${to.endpoint.name}…\n完整报错在"我的 → API 设置"里`, duration: 3000 });
      },
      onCall: (role, o) => {
        if (o.ok) {
          if (!o.fellBack) delete lastErrors[role];
        } else if (!isAbortError(o.error)) {
          noteError(role, o.error);
        }
      },
    }),
  );

  async function hydrate() {
    const [saved, savedFilters, secrets, legacyConns, legacyRoutes, legacySlots] = await Promise.all([
      getOne<Partial<AgentRoute>[]>('settings', 'apiFeatures'),
      getOne<string[]>('settings', 'outputFilters'),
      getEntries<string>('secrets'),
      getOne<LegacyConnection[]>('settings', 'connections'),
      getOne<LegacyRoute[]>('settings', 'routes'),
      getOne<LegacySlots>('settings', 'apiSlots'),
    ]);
    const stored: Record<string, string> = {};
    for (const { key, value } of secrets) if (typeof value === 'string' && value) stored[key] = value;
    if (Array.isArray(saved)) {
      routes.value = completeRoutes(saved);
      for (const [k, v] of Object.entries(stored)) if (k.startsWith('api:')) keys[k] = v;
    } else if (Array.isArray(legacyConns)) {
      // 以前按连接分的设置：转成按功能分，Key 跟着搬过来；旧的连接、分配和 Key 删掉
      const m = legacyMigrate(legacyConns, Array.isArray(legacyRoutes) ? legacyRoutes : [], legacySlots, stored);
      routes.value = m.routes;
      Object.assign(keys, m.keys);
      await write('settings', [{ key: 'apiFeatures', value: clone(routes.value) }], ['connections', 'routes', 'apiSlots']);
      await write(
        'secrets',
        Object.entries(m.keys).map(([key, value]) => ({ key, value })),
        Object.keys(stored).filter((k) => !k.startsWith('api:')),
      );
    }
    if (Array.isArray(savedFilters)) setOutputFilters(savedFilters);
    settingsSaver.start();
    secretSaver.start();
  }

  function routeOf(role: AgentRole): AgentRoute {
    return routes.value.find((r) => r.role === role) as AgentRoute;
  }

  /** 实际提供 API 的设置（跟随主对话时是主对话的） */
  function effectiveRoute(role: AgentRole): AgentRoute {
    return routeOf(system.router.source(role));
  }

  function keyOf(id: string): string | null {
    return keys[id] || null;
  }

  function setKey(id: string, key: string | null) {
    const k = key?.trim();
    if (k) keys[id] = k;
    else delete keys[id];
  }

  function saveRoute(r: AgentRoute) {
    const i = routes.value.findIndex((x) => x.role === r.role);
    if (i >= 0) routes.value[i] = clone(r);
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

  /** 文本功能这次会用的模型（主对话请求体里的 model）；不能用时为空 */
  function chatModelOf(role: AgentRole): string {
    try {
      return system.router.attempts(role)[0]?.endpoint.model ?? '';
    } catch {
      return '';
    }
  }

  /** "Claude · claude-opus-5-5"：功能卡片上的一行 */
  function apiLine(role: AgentRole, api: FeatureApi | null | undefined): string {
    if (!api) return '还没设置';
    return `${apiLabel(api, role)} · ${api.model || '未选模型'}`;
  }

  /**
   * 用设置 + Key 拼一个端点（测试连接、拉模型列表；设置可能还没保存）。
   * 没填 Key 也照样拼：让服务端说哪里不对（它的原话比"还没填 Key"更有用）。
   * listing：拉模型列表用，不需要选好模型。拼不出来（没填地址、渠道做不了这件事）时返回原因
   */
  function endpointOf(api: FeatureApi, role: AgentRole, key: string | null, opts: { backup?: boolean; listing?: boolean } = {}): Endpoint | { reason: string } {
    const target = opts.listing && !api.model.trim() ? { ...api, model: '-' } : api;
    const r = endpointOfApi(target, role, key || 'x', { backup: opts.backup });
    if ('reason' in r) return { reason: r.reason };
    return { ...r.endpoint, key: key?.trim() || null, model: opts.listing ? api.model.trim() : r.endpoint.model };
  }

  return {
    routes,
    outputFilters,
    lastErrors,
    system,
    hydrate,
    routeOf,
    effectiveRoute,
    keyOf,
    setKey,
    saveRoute,
    setOutputFilters,
    status,
    isLive,
    chatModelOf,
    apiLine,
    endpointOf,
  };
});
