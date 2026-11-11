import type { ConnectionKind } from '@app/shared';
import { bearerHeaders, geminiBase, joinUrl, openaiBase, transportOf, trimUrl, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError } from '../core/errors.ts';
import { readText, request } from '../core/http.ts';
import { dropField, sendFixing } from '../llm/retry.ts';
import { decodeFloat32Base64, l2normalize } from './vector.ts';

/**
 * 向量化（设计文档 §4.1 / §6.2）：把记忆和查询变成单位向量，检索在本机做。
 * - OpenAI 兼容 …/embeddings：硅基流动（BAAI/bge-m3、Qwen3-Embedding）、OpenAI、Jina、Ollama、各家中转；
 * - Gemini：…/models/{model}:batchEmbedContents，按用途带 taskType；
 * - Workers AI：…/accounts/{id}/ai/v1/embeddings（OpenAI 兼容，同 SillyTavern；浏览器不能直连，要经自己的 Worker）。
 * 记忆和查询的写法有的模型不同（e5 的 query: / passage:、Qwen3 的查询指令、Gemini 的 taskType），这里按模型自动加；
 * 智能体分配的 extra 里可以用 queryPrefix / documentPrefix 覆盖。
 */

export type EmbedPurpose = 'document' | 'query';

export interface EmbedRequest {
  texts: string[];
  /** 存进记忆的内容用 document，检索时的查询用 query，默认 document */
  purpose?: EmbedPurpose;
  /** 要求的输出维度（OpenAI text-embedding-3、Qwen3-Embedding、Gemini 支持截短）；不给用模型默认 */
  dimensions?: number;
  /** 原样并入请求体；queryPrefix / documentPrefix 不发出去，用来覆盖默认前缀 */
  extra?: Record<string, unknown>;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface EmbedResult {
  /** 和 texts 一一对应，已单位化 */
  vectors: Float32Array[];
  model: string;
  dims: number;
  usage: { inputTokens?: number } | null;
}

type Batch = (ep: Endpoint, inputs: string[], req: EmbedRequest, body: Record<string, unknown>) => Promise<{ vectors: ArrayLike<number>[]; tokens?: number }>;

const openaiBatch: Batch = async (ep, inputs, req, extra) => {
  const url = joinUrl(openaiBase(ep.baseUrl), 'embeddings');
  const body: Record<string, unknown> = { model: ep.model, input: inputs, encoding_format: 'float', ...extra };
  if (req.dimensions) body.dimensions = req.dimensions;
  const send = () => request(transportOf(ep), ep.name, url, { method: 'POST', headers: bearerHeaders(ep), body: JSON.stringify(body), signal: req.signal });
  const { response, errText } = await sendFixing(url, undefined, undefined, send, [
    dropField(body, 'encoding_format', /encoding_format/i),
    dropField(body, 'dimensions', /dimension/i),
  ]);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  const data = await parseJson(response, ep.name);
  const rows = Array.isArray(data?.data) ? [...data.data] : [];
  rows.sort((a: any, b: any) => (a?.index ?? 0) - (b?.index ?? 0));
  const vectors = rows.map((r: any) => (typeof r?.embedding === 'string' ? decodeFloat32Base64(r.embedding) : (r?.embedding as number[])));
  return { vectors, tokens: data?.usage?.prompt_tokens ?? data?.usage?.total_tokens };
};

const geminiBatch: Batch = async (ep, inputs, req) => {
  const model = ep.model.replace(/^models\//, '');
  const url = `${geminiBase(ep.baseUrl)}/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(ep.key ?? '')}`;
  const taskType = req.purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
  const body = {
    requests: inputs.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType,
      ...(req.dimensions ? { outputDimensionality: req.dimensions } : {}),
    })),
  };
  const res = await request(transportOf(ep), ep.name, url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ep.headers ?? {}) }, body: JSON.stringify(body), signal: req.signal });
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  const data = await parseJson(res, ep.name);
  return { vectors: (data?.embeddings ?? []).map((e: any) => e?.values ?? []) };
};

/**
 * Workers AI：用 Cloudflare 的 OpenAI 兼容接口 …/accounts/{id}/ai/v1/embeddings（同 SillyTavern）。
 * Base URL 可以直接填这个地址；只填了账号 ID（extra.accountId）时程序拼出来。浏览器不能直连 Cloudflare，要经自己的 Worker
 */
const workersAiBatch: Batch = async (ep, inputs, req, extra) => {
  let base = trimUrl(ep.baseUrl);
  if (!/^https?:/i.test(base) && ep.extra?.accountId) base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ep.extra.accountId)}/ai/v1`;
  base = base.replace(/\/run(?:\/.*)?$/i, '').replace(/\/ai$/i, '/ai/v1');
  return openaiBatch({ ...ep, baseUrl: base }, inputs, req, extra);
};

async function parseJson(res: Response, provider: string): Promise<any> {
  const text = await readText(res);
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('bad_response', `${provider} 的回复看不懂：${text.slice(0, 200)}`, { retryable: true });
  }
}

const EMBED_PROVIDERS: Partial<Record<ConnectionKind, { batch: Batch; size: number }>> = {
  openai: { batch: openaiBatch, size: 32 },
  gemini: { batch: geminiBatch, size: 100 },
  'workers-ai': { batch: workersAiBatch, size: 50 },
};

export function canEmbed(kind: ConnectionKind): boolean {
  return !!EMBED_PROVIDERS[kind];
}

/** 这个模型在记忆 / 查询前要加的前缀 */
export function instructionPrefix(model: string, purpose: EmbedPurpose, extra?: Record<string, unknown>): string {
  const custom = purpose === 'query' ? extra?.queryPrefix : extra?.documentPrefix;
  if (typeof custom === 'string') return custom;
  const m = model.toLowerCase();
  if (/qwen3-embedding/.test(m)) return purpose === 'query' ? 'Instruct: Given a chat message, retrieve memories that are relevant to it\nQuery: ' : '';
  if (/(?:^|[/-])e5-/.test(m)) return purpose === 'query' ? 'query: ' : 'passage: ';
  if (/bge-(?:large|base|small)-zh/.test(m)) return purpose === 'query' ? '为这个句子生成表示以用于检索相关文章：' : '';
  return '';
}

export async function embedTexts(ep: Endpoint, req: EmbedRequest): Promise<EmbedResult> {
  const provider = EMBED_PROVIDERS[ep.kind];
  if (!provider) throw new AiError('unsupported', `"${ep.name}" 是 ${ep.kind} 连接，不能做向量化`);
  if (!req.texts.length) return { vectors: [], model: ep.model, dims: 0, usage: null };
  const { queryPrefix: _q, documentPrefix: _d, ...bodyExtra } = req.extra ?? {};
  const prefix = instructionPrefix(ep.model, req.purpose ?? 'document', req.extra);
  // 空字符串多数接口会报错：换成一个空格
  const inputs = req.texts.map((t) => prefix + (t.trim() ? t : ' '));
  const size = Math.max(1, req.batchSize ?? provider.size);
  const vectors: Float32Array[] = [];
  let tokens = 0;
  let counted = false;
  for (let i = 0; i < inputs.length; i += size) {
    const chunk = inputs.slice(i, i + size);
    const r = await provider.batch(ep, chunk, req, bodyExtra);
    if (r.vectors.length !== chunk.length) {
      throw new AiError('bad_response', `${ep.name} 返回了 ${r.vectors.length} 个向量，应该是 ${chunk.length} 个`, { retryable: true });
    }
    for (const v of r.vectors) vectors.push(l2normalize(v));
    if (typeof r.tokens === 'number') {
      tokens += r.tokens;
      counted = true;
    }
  }
  const dims = vectors[0]?.length ?? 0;
  if (!dims || vectors.some((v) => v.length !== dims)) throw new AiError('bad_response', `${ep.name} 返回的向量维度不一致`, { retryable: true });
  return { vectors, model: ep.model, dims, usage: counted ? { inputTokens: tokens } : null };
}
