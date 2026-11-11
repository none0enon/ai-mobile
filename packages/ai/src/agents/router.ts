import { AGENT_META, type AgentRole, type AgentRoute, type Capability, type ConnectionKind, type ProviderConnection } from '@app/shared';
import type { Endpoint } from '../core/endpoint.ts';
import { AiError, errorText, shouldFailover } from '../core/errors.ts';
import type { Transport } from '../core/http.ts';
import { canEmbed } from '../embedding/client.ts';
import { canDraw } from '../image/client.ts';
import { canChat } from '../llm/client.ts';
import { canSpeak } from '../tts/client.ts';

/**
 * 智能体路由（设计文档 §4.1）：每个智能体单独选"连接 + 模型 + 备用连接"。
 * 路由把分配解析成要试的端点（主连接，再备用连接），按顺序调用：主连接失败且值得换时改用备用（同 math-reader 的 callAI）。
 * 配置从哪里来由调用方决定：App 里是本机的设置，以后的 Worker 里是 D1。
 */

export interface AgentConfig {
  connections(): ProviderConnection[];
  routes(): AgentRoute[];
  /** 这台设备上保存的 Key；没有返回 null */
  keyOf(connectionId: string): string | null;
  /** 经自己的 Worker 转发时用的请求函数；还没连上 Worker 时返回 null */
  relay?(conn: ProviderConnection): Transport | null;
}

export interface Attempt {
  endpoint: Endpoint;
  connection: ProviderConnection;
  /** 这是备用连接 */
  fallback: boolean;
}

export type RouteStatus =
  | { live: true; route: AgentRoute; connection: ProviderConnection }
  | { live: false; reason: string; code: 'no_route' | 'no_key' | 'unsupported' | 'network'; route?: AgentRoute; connection?: ProviderConnection };

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

export class AgentRouter {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  route(role: AgentRole): AgentRoute | undefined {
    return this.config.routes().find((r) => r.role === role);
  }

  connection(id: string | null | undefined): ProviderConnection | undefined {
    return id ? this.config.connections().find((c) => c.id === id && !c.deleted) : undefined;
  }

  /**
   * 一个连接能不能用来做 cap：协议支持、Key 在、需要转发时已连上 Worker。
   * Key 交给 Worker 而本机没有时，只能经 Worker 转发。
   */
  endpointFor(conn: ProviderConnection, model: string, cap: Capability): { endpoint: Endpoint } | { reason: string; code: 'no_key' | 'unsupported' | 'network' } {
    if (!kindCan(conn.kind, cap)) return { reason: `"${conn.name}" 不能做${capLabel(cap)}`, code: 'unsupported' };
    const key = this.config.keyOf(conn.id);
    let transport: Transport | undefined;
    if (conn.viaWorker || (!key && conn.keyStorage === 'hub')) {
      const relay = this.config.relay?.(conn) ?? null;
      if (!relay) {
        return {
          reason: conn.viaWorker ? `"${conn.name}" 设置了经 Worker 转发，但还没连上自己的 Worker` : `"${conn.name}" 的 Key 交给了 Worker，这台设备上没有，要经 Worker 转发`,
          code: 'network',
        };
      }
      transport = relay;
    } else if (!key && conn.keyStorage !== 'none') {
      return { reason: `"${conn.name}" 还没在这台设备上填 Key`, code: 'no_key' };
    }
    return {
      endpoint: {
        connectionId: conn.id,
        name: conn.name,
        kind: conn.kind,
        baseUrl: conn.baseUrl,
        key,
        model,
        headers: conn.extraHeaders,
        extra: conn.extra,
        transport,
      },
    };
  }

  /** 主连接能不能用；不能时说明原因（界面据此决定用演示模型还是真的调用） */
  status(role: AgentRole): RouteStatus {
    const route = this.route(role);
    if (!route?.connectionId) return { live: false, reason: `还没给"${AGENT_META[role].label}"分配连接`, code: 'no_route', route };
    const conn = this.connection(route.connectionId);
    if (!conn) return { live: false, reason: `"${AGENT_META[role].label}"分配的连接已经删除`, code: 'no_route', route };
    if (!route.model && role !== 'tts') return { live: false, reason: `"${AGENT_META[role].label}"还没选模型`, code: 'no_route', route, connection: conn };
    const r = this.endpointFor(conn, route.model, AGENT_META[role].capability);
    if ('reason' in r) return { live: false, reason: r.reason, code: r.code, route, connection: conn };
    return { live: true, route, connection: conn };
  }

  /**
   * 要试的端点：主连接，再备用连接（模型没填时沿用主模型）。
   * override 用来临时换连接或模型（例如角色单独选的 TTS 连接）。不能用的连接跳过；一个都不能用时报主连接的原因。
   */
  attempts(role: AgentRole, override: { connectionId?: string | null; model?: string } = {}): Attempt[] {
    const route = this.route(role);
    const cap = AGENT_META[role].capability;
    const primaryId = override.connectionId || route?.connectionId;
    const model = override.model || route?.model || '';
    const list: { conn: ProviderConnection | undefined; model: string; fallback: boolean }[] = [{ conn: this.connection(primaryId), model, fallback: false }];
    if (route?.fallbackConnectionId && route.fallbackConnectionId !== primaryId) {
      list.push({ conn: this.connection(route.fallbackConnectionId), model: route.fallbackModel || model, fallback: true });
    }
    const out: Attempt[] = [];
    let firstProblem: AiError | null = null;
    for (const item of list) {
      if (!item.conn) {
        firstProblem ??= new AiError('no_route', item.fallback ? '备用连接已经删除' : `还没给"${AGENT_META[role].label}"分配连接`);
        continue;
      }
      const r = this.endpointFor(item.conn, item.model, cap);
      if ('reason' in r) {
        firstProblem ??= new AiError(r.code, r.reason);
        continue;
      }
      out.push({ endpoint: r.endpoint, connection: item.conn, fallback: item.fallback });
    }
    if (!out.length) throw firstProblem ?? new AiError('no_route', `还没给"${AGENT_META[role].label}"分配连接`);
    return out;
  }

  /**
   * 依次试端点：主连接失败、且错误值得换连接时（不是取消、不是超预算）改用下一个，并调用 onFailover。
   * 全部失败时报最后一个错误，消息里带上主连接的错误。
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
        // 主连接不能用（没填 Key 等）时第一个就是备用连接：也算用了备用
        return { value: await fn(attempt.endpoint, attempt), attempt, fellBack: i > 0 || attempt.fallback };
      } catch (e) {
        const next = attempts[i + 1];
        if (!next || !shouldFailover(e)) {
          if (first !== null && e instanceof AiError) {
            throw new AiError(e.code, `${errorText(first)}\n备用连接也失败了：${e.message}`, { status: e.status, retryable: e.retryable, detail: e.detail, cause: e });
          }
          throw e;
        }
        first ??= e;
        onFailover?.(attempt, next, e);
      }
    }
    throw new AiError('no_route', '没有可用的连接');
  }
}

function capLabel(cap: Capability): string {
  return { chat: '对话', vision: '识图', embedding: '向量化', tts: '语音合成', stt: '语音识别', image: '生图', maps: '地图' }[cap];
}
