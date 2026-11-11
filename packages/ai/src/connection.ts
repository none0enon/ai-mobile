import type { Capability } from '@app/shared';
import { anthropicBase, bearerHeaders, geminiBase, joinUrl, openaiBase, transportOf, type Endpoint } from './core/endpoint.ts';
import { AiError, errorText, httpError } from './core/errors.ts';
import { readText, request } from './core/http.ts';
import { embedTexts } from './embedding/client.ts';
import { NOVELAI_MODELS } from './image/presets.ts';
import { novelaiSubscription } from './image/novelai.ts';
import { chatOnce } from './llm/client.ts';
import { synthesize } from './tts/client.ts';
import type { VoiceSpec } from './tts/types.ts';

/**
 * "API 与智能体"页的两个按钮：拉取模型列表、测试连接（移植自 math-reader 的 fetchModels，扩展到各家）。
 */

export const STATIC_MODELS: Partial<Record<Endpoint['kind'], string[]>> = {
  novelai: NOVELAI_MODELS,
  minimax: ['speech-02-hd', 'speech-02-turbo', 'speech-2.5-hd-preview', 'speech-2.5-turbo-preview'],
  // 火山引擎的"模型"就是 Resource ID
  volcengine: ['seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-2.0', 'seed-icl-1.0'],
  'fish-audio': ['s1', 'speech-1.6', 'speech-1.5'],
  'gpt-sovits': ['gpt-sovits'],
  'workers-ai': ['@cf/baai/bge-m3', '@cf/baai/bge-large-en-v1.5', '@cf/baai/bge-base-en-v1.5'],
};

export async function listModels(ep: Endpoint, signal?: AbortSignal): Promise<string[]> {
  const fixed = STATIC_MODELS[ep.kind];
  if (fixed) return [...fixed];
  let res: Response;
  if (ep.kind === 'gemini') {
    // Gemini：GET {base}/models?key=…，只留能对话或能向量化的模型
    res = await request(transportOf(ep), ep.name, `${geminiBase(ep.baseUrl)}/models?pageSize=1000&key=${encodeURIComponent(ep.key ?? '')}`, { method: 'GET', signal });
    if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
    const data = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
    return (data.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.some((x) => x === 'generateContent' || x === 'embedContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  if (ep.kind === 'anthropic') {
    res = await request(transportOf(ep), ep.name, joinUrl(anthropicBase(ep.baseUrl), 'models?limit=1000'), {
      method: 'GET',
      headers: { ...(ep.key ? { 'x-api-key': ep.key } : {}), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...(ep.headers ?? {}) },
      signal,
    });
  } else if (ep.kind === 'openai') {
    res = await request(transportOf(ep), ep.name, joinUrl(openaiBase(ep.baseUrl), 'models'), { method: 'GET', headers: bearerHeaders(ep, false), signal });
  } else {
    return [];
  }
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  const data = (await res.json()) as { data?: unknown[]; models?: unknown[] };
  const rows = data.data ?? data.models ?? [];
  return rows
    .map((m) => (typeof m === 'string' ? m : ((m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? '')))
    .filter(Boolean)
    .sort();
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

/** 没有指定音色时，测试用各家的系统音色 */
function defaultVoice(ep: Endpoint): VoiceSpec | null {
  if (ep.kind === 'openai') return { voiceId: ep.model.includes('/') ? 'anna' : 'alloy' };
  if (ep.kind === 'minimax') return { voiceId: 'female-shaonv' };
  if (ep.kind === 'volcengine') return { voiceId: 'zh_female_vv_uranus_bigtts' };
  if (ep.kind === 'fish-audio') return { voiceId: '' };
  return null;
}

/**
 * 按这个连接要做的事测一次：对话发一句很短的话；向量化算一句话；语音合成读"你好"；
 * NovelAI 查订阅（不出图，不花点数）。其余生图接口只拉模型列表——真出一张图会花钱。
 */
export async function testConnection(ep: Endpoint, capability: Capability, opts: { voice?: VoiceSpec; signal?: AbortSignal } = {}): Promise<TestResult> {
  const started = Date.now();
  const done = (ok: boolean, message: string): TestResult => ({ ok, latencyMs: Date.now() - started, message });
  try {
    switch (capability) {
      case 'chat':
      case 'vision': {
        try {
          const r = await chatOnce(ep, { messages: [{ role: 'user', content: '测试连接：请只回复一个字"在"。' }], maxTokens: 64, temperature: 0 }, { stream: false, signal: opts.signal });
          return done(true, `回复：${r.text.trim().slice(0, 40)}`);
        } catch (e) {
          // 会思考的模型可能把 64 个 token 都用在思考上：接口是通的
          if (e instanceof AiError && e.code === 'empty') return done(true, '连接正常（回复为空：可能是会思考的模型，测试时给的输出上限太小）');
          throw e;
        }
      }
      case 'embedding': {
        const r = await embedTexts(ep, { texts: ['测试连接'], signal: opts.signal });
        return done(true, `${r.dims} 维向量`);
      }
      case 'tts': {
        const voice = opts.voice ?? defaultVoice(ep);
        if (!voice) return done(false, 'GPT-SoVITS 要先在角色的语音里填参考音频，再试听');
        const a = await synthesize(ep, { text: '你好呀，能听到我吗？', voice, signal: opts.signal });
        return done(true, `收到 ${(a.bytes.length / 1024).toFixed(1)} KB 音频（${a.mime}）`);
      }
      case 'image': {
        if (ep.kind === 'novelai') {
          const s = await novelaiSubscription(ep, opts.signal);
          if (!s) return done(true, '站点能连上，但查不到订阅（公益站一般没有这个接口）');
          const tier = ['未订阅', 'Tablet', 'Scroll', 'Opus'][s.tier] ?? `等级 ${s.tier}`;
          return done(s.active, `${tier}${s.active ? '' : '（未生效）'} · 剩 ${s.anlas} 点${s.unlimited || s.tier >= 3 ? ' · 小图免点数' : ''}`);
        }
        const models = await listModels(ep, opts.signal);
        return done(true, `接口正常（${models.length} 个模型）；没有真的出图，免得花钱`);
      }
      default:
        return done(false, '这类连接还不能测试');
    }
  } catch (e) {
    return done(false, errorText(e));
  }
}
