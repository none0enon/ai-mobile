import { AGENT_META, apiKeyId, isTextRole, type AgentRole, type AgentRoute, type Capability, type ConnectionKind, type FeatureApi } from '@app/shared';
import { apiLabel, kindOf, needsKey } from '../channels.ts';
import type { Endpoint } from '../core/endpoint.ts';
import { AiError, annotateError, errorText, shouldFailover } from '../core/errors.ts';
import { canEmbed } from '../embedding/client.ts';
import { canDraw } from '../image/client.ts';
import { canChat } from '../llm/client.ts';
import { canSpeak } from '../tts/client.ts';

/**
 * 功能路由：API 设置按功能分，每个功能自己选渠道、填地址、Key、模型，可以再设一个备用 API。
 * 主对话以外的文本功能默认跟随主对话（用主对话的 API 和备用 API）。
 * 路由把设置解析成要试的端点（自己的 API，再备用 API），按顺序调用：失败且值得换时改用备用（同 math-reader 的 callAI）。
 * 设置从哪里来由调用方决定：App 里是本机的设置，以后的 Worker 里是 D1。
 */

export interface AgentConfig {
  routes(): AgentRoute[];
  /** 这台设备上保存的 Key（键见 apiKeyId）；没有返回 null */
  keyOf(id: string): string | null;
}

export interface Attempt {
  endpoint: Endpoint;
  /** 用的是哪个功能的设置（跟随主对话时是 main） */
  source: AgentRole;
  /** 这是备用 API */
  fallback: boolean;
  /** 设置本身（界面显示渠道、模型） */
  api: FeatureApi;
}

export type RouteCode = 'no_route' | 'no_key' | 'unsupported' | 'network';

export type RouteStatus =
  | { live: true; route: AgentRoute; api: FeatureApi; source: AgentRole }
  | { live: false; reason: string; code: RouteCode; route?: AgentRoute; api?: FeatureApi; source?: AgentRole };

/** 这种协议能不能做这件事 */
export function kindCan(kind: ConnectionKind, cap: Capability): boolean {
  switch (cap) {
    case 'chat':
    case 'vision':
      return canChat(kind);
    case 'embedding':
      return canEmbed(kind);
    case 'tts':
      return canSpeak(kind);
    case 'image':
      return canDraw(kind);
    case 'maps':
      return kind === 'google-maps';
    default:
      return false;
  }
}

function capLabel(cap: Capability): string {
  return { chat: '对话', vision: '识图', embedding: '向量化', tts: '语音合成', stt: '语音识别', image: '生图', maps: '地图' }[cap];
}

/**
 * 用一个功能的 API 设置拼端点：渠道 → 协议，地址、模型、Key 都要有（自建服务、本机和局域网地址可以不填 Key）。
 * 不能用时说明原因
 */
export function endpointOfApi(
  api: FeatureApi,
  role: AgentRole,
  key: string | null,
  opts: { backup?: boolean; model?: string } = {},
): { endpoint: Endpoint } | { reason: string; code: RouteCode } {
  const cap = AGENT_META[role].capability;
  const kind = kindOf(api, role);
  const name = `${apiLabel(api, role)}${opts.backup ? '（备用）' : ''}`;
  if (cap === 'stt') return { reason: '语音识别还没接入，设置会先存着', code: 'unsupported' };
  if (!kindCan(kind, cap)) return { reason: `${name}不能做${capLabel(cap)}`, code: 'unsupported' };
  if (!api.baseUrl.trim()) return { reason: `${name}还没填地址`, code: 'no_route' };
  const model = (opts.model ?? api.model).trim();
  // 语音合成的模型可以按角色填；Fish Audio、GPT-SoVITS 不填模型也行
  if (!model && cap !== 'tts') return { reason: `${name}还没选模型`, code: 'no_route' };
  const k = key?.trim() || null;
  if (!k && needsKey(api)) return { reason: `${name}还没填 Key`, code: 'no_key' };
  return {
    endpoint: {
      connectionId: apiKeyId(role, opts.backup),
      name,
      kind,
      baseUrl: api.baseUrl.trim(),
      key: k,
      model,
      headers: api.headers,
      extra: api.extra,
      promptProcessing: api.promptProcessing,
      includeBody: api.includeBody,
      excludeBody: api.excludeBody,
    },
  };
}

/** 出错时补上是哪个 API、哪个模型（完整报错里列出来） */
export function annotateAttempt(e: unknown, ep: Endpoint): unknown {
  return annotateError(e, { api: ep.name, kind: ep.kind, model: ep.model || undefined });
}

export class AgentRouter {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  route(role: AgentRole): AgentRoute | undefined {
    return this.config.routes().find((r) => r.role === role);
  }

  /** 真正提供 API 设置的功能：主对话以外的文本功能跟随主对话时是 main */
  source(role: AgentRole): AgentRole {
    return role !== 'main' && isTextRole(role) && this.route(role)?.sameAsMain ? 'main' : role;
  }

  /** 实际用的设置（跟随主对话时是主对话的） */
  effective(role: AgentRole): AgentRoute | undefined {
    return this.route(this.source(role));
  }

  private problem(role: AgentRole): { reason: string; code: RouteCode } {
    const source = this.source(role);
    const follow = source !== role ? '（跟随主对话）' : '';
    return { reason: `${AGENT_META[source].label}还没设置 API${follow}`, code: 'no_route' };
  }

  /**
   * 要试的端点：自己的 API，再备用 API。model 用来临时换模型（例如角色单独填的 TTS 模型，只用在自己的 API 上）。
   * 不能用的跳过；一个都不能用时报自己的 API 的原因
   */
  attempts(role: AgentRole, override: { model?: string } = {}): Attempt[] {
    const source = this.source(role);
    const r = this.route(source);
    const list: { api: FeatureApi; fallback: boolean }[] = [];
    if (r?.api) list.push({ api: r.api, fallback: false });
    if (r?.backup) list.push({ api: r.backup, fallback: true });
    if (!list.length) {
      const p = this.problem(role);
      throw new AiError(p.code, p.reason);
    }
    const out: Attempt[] = [];
    let firstProblem: AiError | null = null;
    for (const item of list) {
      const e = endpointOfApi(item.api, role, this.config.keyOf(apiKeyId(source, item.fallback)), {
        backup: item.fallback,
        model: item.fallback ? undefined : override.model || undefined,
      });
      if ('reason' in e) {
        firstProblem ??= new AiError(e.code, e.reason);
        continue;
      }
      out.push({ endpoint: e.endpoint, source, fallback: item.fallback, api: item.api });
    }
    if (!out.length) throw firstProblem ?? new AiError('no_route', this.problem(role).reason);
    return out;
  }

  /** 能不能真的调用；不能时说明原因（界面据此决定用演示模型还是真的调用） */
  status(role: AgentRole): RouteStatus {
    const route = this.route(role);
    const source = this.source(role);
    try {
      const first = this.attempts(role)[0] as Attempt;
      return { live: true, route: route as AgentRoute, api: first.api, source };
    } catch (e) {
      const code = e instanceof AiError && e.code !== 'http' ? (e.code as RouteCode) : 'no_route';
      return { live: false, reason: errorText(e), code, route, api: this.route(source)?.api ?? undefined, source };
    }
  }

  /**
   * 依次试端点：失败、且错误值得换时（不是取消、不是超预算）改用下一个，并调用 onFailover。
   * 每个错误都补上是哪个 API、哪个模型；全部失败时报最后一个错误，消息里带上先失败的那个，完整报错里两边都有。
   */
  async run<T>(
    attempts: Attempt[],
    fn: (ep: Endpoint, attempt: Attempt) => Promise<T>,
    onFailover?: (from: Attempt, to: Attempt, error: unknown) => void,
  ): Promise<{ value: T; attempt: Attempt; fellBack: boolean }> {
    let first: unknown = null;
    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i] as Attempt;
      try {
        // 自己的 API 不能用（没填 Key 等）时第一个就是备用：也算用了备用
        return { value: await fn(attempt.endpoint, attempt), attempt, fellBack: i > 0 || attempt.fallback };
      } catch (raw) {
        const e = annotateAttempt(raw, attempt.endpoint);
        const next = attempts[i + 1];
        if (!next || !shouldFailover(e)) {
          if (first !== null && e instanceof AiError) {
            throw new AiError(e.code, `${errorText(first)}\n备用 API 也失败了：${e.message}`, {
              status: e.status,
              retryable: e.retryable,
              detail: e.detail,
              cause: (e as Error & { cause?: unknown }).cause,
              context: e.context,
              previous: first,
            });
          }
          throw e;
        }
        first ??= e;
        onFailover?.(attempt, next, e);
      }
    }
    throw new AiError('no_route', '没有可用的 API');
  }
}
