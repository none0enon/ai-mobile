import { base64Decode, base64Encode } from '@app/shared';
import { joinUrl, transportOf, trimUrl, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError } from '../core/errors.ts';
import { readText, request } from '../core/http.ts';
import type { TtsCall, TtsOutput } from './providers.ts';

/**
 * 火山引擎豆包语音合成（移植自 SleepTogether 的 tts-manager，请求体对照 SillyTavern 的 volcengine 接口）。
 * - 合成：POST https://openspeech.bytedance.com/api/v3/tts/unidirectional，返回逐行 JSON：
 *   code 0 带一段 base64 音频，20000000 表示结束，其余是错误；
 * - 鉴权：APP ID（连接的 extra.appId）+ Access Token（Key）+ Resource ID（这里用模型名：seed-tts-2.0 等）。
 *   复刻的音色（S_ 开头）要用 seed-icl 系列，自动换；
 * - 请求头：浏览器直连时用 SleepTogether 实际在用的 X-Api-App-Key；被拒（401 / 403）再按官方文档的 X-Api-App-Id 试一次；
 * - 声音复刻：上传音频（mega_tts/audio/upload）和查训练状态（mega_tts/status），同 SleepTogether。
 */
export const VOLCENGINE_DEFAULT_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export function isClonedVoice(voice: string): boolean {
  return /^S_[A-Za-z0-9_-]+$/.test(voice.trim());
}

/** 复刻的音色要用 seed-icl 系列的 Resource ID */
export function volcResourceId(resourceId: string | undefined, voice: string): string {
  const id = resourceId?.trim() || 'seed-tts-2.0';
  return isClonedVoice(voice) && /^seed-tts-/i.test(id) ? 'seed-icl-2.0' : id;
}

function ttsUrl(ep: Endpoint): string {
  const base = trimUrl(ep.baseUrl || VOLCENGINE_DEFAULT_URL);
  return /\/api\//.test(base) ? base : joinUrl(base, 'api/v3/tts/unidirectional');
}

function origin(ep: Endpoint): string {
  try {
    return new URL(ep.baseUrl || VOLCENGINE_DEFAULT_URL).origin;
  } catch {
    return 'https://openspeech.bytedance.com';
  }
}

/** Access Token 有时被复制成 "Bearer; xxx"：去掉前缀 */
function accessToken(ep: Endpoint): string {
  return (ep.key ?? '').trim().replace(/^Bearer\s*;?\s*/i, '');
}

export async function volcengineSpeech(ep: Endpoint, call: TtsCall): Promise<TtsOutput> {
  const { req } = call;
  const appId = ep.extra?.appId?.trim();
  if (!appId) throw new AiError('no_key', `"${ep.name}" 还没填火山引擎的 APP ID`);
  const voice = req.voice.voiceId.trim();
  const resourceId = volcResourceId(req.voice.model || ep.model, voice);
  const speed = req.voice.speed ?? 1;
  const body = {
    user: { uid: 'ai-mobile' },
    req_params: {
      text: call.text,
      speaker: voice,
      audio_params: {
        format: 'mp3',
        sample_rate: 24000,
        ...(speed !== 1 ? { speech_rate: Math.max(-50, Math.min(100, Math.round((speed - 1) * 100))) } : {}),
      },
      additions: JSON.stringify({ context_texts: [] }),
    },
  };
  const send = (appIdHeader: string) =>
    request(transportOf(ep), ep.name, ttsUrl(ep), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [appIdHeader]: appId,
        'X-Api-Access-Key': accessToken(ep),
        'X-Api-Resource-Id': resourceId,
        ...(ep.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  let res = await send('X-Api-App-Key');
  if (res.status === 401 || res.status === 403) {
    await readText(res);
    res = await send('X-Api-App-Id');
  }
  if (!res.ok) {
    const text = await readText(res);
    if (isClonedVoice(voice) && !/^seed-icl-/i.test(resourceId)) {
      throw new AiError('http', `${ep.name}：复刻音色 ${voice} 要用 seed-icl-2.0 一类的 Resource ID（${res.status}）`, { status: res.status, detail: text });
    }
    throw httpError(ep.name, res.status, text);
  }
  const chunks: Uint8Array[] = [];
  for (const raw of (await readText(res)).split('\n')) {
    const line = raw.trim().replace(/^data:\s*/, '');
    if (!line) continue;
    let data: { code?: number; message?: string; data?: string } | null = null;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    const code = Number(data?.code ?? 0);
    if (code === 0 && data?.data) chunks.push(base64Decode(data.data));
    else if (code === 20000000) break;
    else if (code > 0) throw new AiError('http', `${ep.name} 返回错误 ${code}：${data?.message ?? ''}`, { status: 400, detail: line.slice(0, 2000) });
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (!total) throw new AiError('empty', `${ep.name} 没有返回音频`, { retryable: true });
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { bytes, mime: 'audio/mpeg', model: resourceId };
}

const CLONE_HINTS: Record<number, string> = { 1106: 'Speaker ID 重复', 1107: 'Speaker ID 未找到', 1111: '音频里没有人声', 1122: '没检测到人声', 1123: '已达上传次数上限' };

function cloneError(data: Record<string, any>): AiError {
  const base = data?.BaseResp ?? {};
  const code = base.StatusCode ?? data?.code ?? 'N/A';
  const hint = CLONE_HINTS[Number(code)];
  return new AiError('http', `豆包声音复刻失败：${base.StatusMessage || data?.message || '未知错误'}${hint ? `（${hint}）` : ''}，code=${code}`, { status: 400 });
}

/**
 * 声音复刻：上传一段音频（不超过 10 MB）训练一个复刻音色。speakerId 是控制台里买的音色位（S_ 开头）。
 * modelType 4 对应 seed-icl-2.0，其余 seed-icl-1.0（同 SleepTogether）
 */
export async function volcengineClone(
  ep: Endpoint,
  opts: { speakerId: string; audio: Uint8Array; format: string; modelType?: number; language?: number; signal?: AbortSignal },
): Promise<{ speakerId: string; resourceId: string }> {
  const appId = ep.extra?.appId?.trim();
  if (!appId) throw new AiError('no_key', `"${ep.name}" 还没填火山引擎的 APP ID`);
  if (!opts.speakerId.trim()) throw new AiError('no_route', '还没填 Speaker ID（S_ 开头的音色位）');
  if (opts.audio.length > 10 * 1024 * 1024) throw new AiError('unsupported', '用来复刻的音频不能超过 10 MB');
  const modelType = opts.modelType ?? 4;
  const resourceId = modelType === 4 ? 'seed-icl-2.0' : 'seed-icl-1.0';
  const res = await request(transportOf(ep), ep.name, `${origin(ep)}/api/v1/mega_tts/audio/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer; ${accessToken(ep)}`, 'Resource-Id': resourceId },
    body: JSON.stringify({
      appid: appId,
      speaker_id: opts.speakerId.trim(),
      audios: [{ audio_bytes: base64Encode(opts.audio), audio_format: opts.format.toLowerCase() }],
      source: 2,
      model_type: modelType,
      language: opts.language ?? 0,
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  const data = (await res.json()) as Record<string, any>;
  if (data?.BaseResp?.StatusCode !== 0) throw cloneError(data);
  return { speakerId: data.speaker_id || opts.speakerId.trim(), resourceId };
}

export const CLONE_STATUS: Record<number, string> = { 0: '未找到', 1: '训练中', 2: '训练成功', 3: '训练失败', 4: '已激活' };

export async function volcengineCloneStatus(ep: Endpoint, speakerId: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const appId = ep.extra?.appId?.trim();
  if (!appId) throw new AiError('no_key', `"${ep.name}" 还没填火山引擎的 APP ID`);
  const res = await request(transportOf(ep), ep.name, `${origin(ep)}/api/v1/mega_tts/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer; ${accessToken(ep)}`, 'Resource-Id': 'seed-icl-2.0' },
    body: JSON.stringify({ appid: appId, speaker_id: speakerId.trim() }),
    signal,
  });
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  const data = (await res.json()) as Record<string, any>;
  if (data?.BaseResp?.StatusCode !== 0) throw cloneError(data);
  const status = Number(data.status ?? 0);
  return { status, text: CLONE_STATUS[status] ?? '未知' };
}
