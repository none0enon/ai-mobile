import type { ConnectionKind, PromptProcessing } from '@app/shared';
import { defaultTransport, type Transport } from './http.ts';

/**
 * 一次调用需要的全部信息：连接（协议、地址、Key、请求方式）+ 这次用的模型。
 * 由智能体路由（agents/router.ts）从"连接 + 智能体分配"解析出来；各家协议的代码只认它。
 */
export interface Endpoint {
  connectionId: string;
  /** 连接名称，报错和降级提示里用（"中转站 A 返回 429…"） */
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  /** 不需要 Key 的连接（本地 Ollama、自建 GPT-SoVITS、经自己 Worker 的 Workers AI）为空 */
  key: string | null;
  model: string;
  /** 连接里填的额外请求头 */
  headers?: Record<string, string>;
  /** 服务商专有设置（ProviderConnection.extra） */
  extra?: Record<string, string>;
  /** 仅 OpenAI 兼容的对话：消息整理方式、额外 / 去掉的请求字段（同 SillyTavern 的自定义来源设置） */
  promptProcessing?: PromptProcessing;
  includeBody?: Record<string, unknown>;
  excludeBody?: string[];
  /** 默认全局 fetch；经 Worker 转发时换掉 */
  transport?: Transport;
}

export function transportOf(ep: Endpoint): Transport {
  return ep.transport ?? defaultTransport;
}

/** 去掉首尾空白和末尾的斜杠 */
export function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function joinUrl(base: string, path: string): string {
  return `${trimUrl(base)}/${path.replace(/^\/+/, '')}`;
}

function originOnly(url: string): boolean {
  return /^https?:\/\/[^/]+$/i.test(url);
}

const OPENAI_SUFFIX = /\/(?:chat\/completions|completions|embeddings|audio\/speech|audio\/transcriptions|images\/generations|models)$/i;

/**
 * OpenAI 兼容接口的 Base URL。设置里填 Base URL（如 https://api.example.com/v1），程序按用途拼路径；
 * 也容忍从 math-reader 习惯粘过来的完整地址（…/v1/chat/completions）。
 * 只填了域名时补 /v1：各家中转（one-api / new-api）、DeepSeek、硅基流动、Ollama 都是这个约定。
 */
export function openaiBase(url: string): string {
  let u = trimUrl(url).replace(OPENAI_SUFFIX, '');
  u = trimUrl(u);
  return originOnly(u) ? `${u}/v1` : u;
}

export const DEEPSEEK_DEFAULT_URL = 'https://api.deepseek.com';

/**
 * DeepSeek 的 Base URL：官网写 https://api.deepseek.com（不带 /v1），对话是 {base}/chat/completions；
 * 也容忍 math-reader 习惯的完整地址（…/v1/chat/completions）。
 */
export function deepseekBase(url: string): string {
  return trimUrl(trimUrl(url || DEEPSEEK_DEFAULT_URL).replace(OPENAI_SUFFIX, '')) || DEEPSEEK_DEFAULT_URL;
}

/** 是不是 DeepSeek 官方接口（前缀续写的 /beta、停用的旧模型名只对官方处理） */
export function isDeepSeekOfficial(url: string): boolean {
  try {
    return new URL(trimUrl(url)).hostname === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** Gemini Enterprise Agent Platform（原 Vertex AI）express 模式的全球地址，同 math-reader 的 Vertex Agent 默认地址 */
export const VERTEX_DEFAULT_URL = 'https://aiplatform.googleapis.com/v1/publishers/google';

/**
 * Vertex 的 Gemini Base URL（同 math-reader 的 geminiBaseUrl）：基础地址、…/models、
 * 完整的 …/models/gemini-x:streamGenerateContent?key=… 都认；只填了域名时补 /v1/publishers/google。
 */
export function vertexBase(url: string): string {
  const u = trimUrl(trimUrl((url || VERTEX_DEFAULT_URL).replace(/[?#].*$/, '')).replace(/\/models(?:\/[^/]+)?$/i, ''));
  return originOnly(u) ? `${u}/v1/publishers/google` : u;
}

/** Anthropic Messages 接口的 Base URL（https://api.anthropic.com/v1） */
export function anthropicBase(url: string): string {
  const u = trimUrl(trimUrl(url).replace(/\/(?:messages|models)$/i, ''));
  return originOnly(u) ? `${u}/v1` : u;
}

/**
 * Gemini 原生接口的 Base URL（https://generativelanguage.googleapis.com/v1beta）。
 * 兼容 …/v1beta/、…/v1beta/models、…/models/gemini-2.5-flash:generateContent?key=… 这几种粘法（同 math-reader）。
 */
export function geminiBase(url: string): string {
  const u = trimUrl(trimUrl(url.replace(/[?#].*$/, '')).replace(/\/models(?:\/.*)?$/i, ''));
  return originOnly(u) ? `${u}/v1beta` : u;
}

/** Bearer 鉴权头（有 Key 才带）+ 连接里的额外请求头 */
export function bearerHeaders(ep: Endpoint, json = true): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}),
    ...(ep.headers ?? {}),
  };
}
