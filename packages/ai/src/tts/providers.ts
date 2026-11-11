import { bearerHeaders, joinUrl, openaiBase, transportOf, trimUrl, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError } from '../core/errors.ts';
import { readBytes, readText, request, type Bytes } from '../core/http.ts';
import { hexToBytes } from '../core/util.ts';
import { dropField, sendFixing } from '../llm/retry.ts';
import { emotionInChinese, fishEmotion, minimaxEmotion } from './emotion.ts';
import { guessLanguage } from './text.ts';
import type { AudioFormat, TtsRequest } from './types.ts';

/**
 * 各家语音合成接口（设计文档 §11.1；sleep-together 里角色带 voiceId、语音消息存成音频文件的做法也沿用）。
 * 输入的文字已经处理过（去掉动作描写等），emotion 是通用情绪词或 null。返回音频字节和类型。
 */
export interface TtsCall {
  text: string;
  emotion: string | null;
  req: TtsRequest;
}

export interface TtsOutput {
  bytes: Bytes;
  mime: string;
  model: string;
}

const MIME: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/L16',
};

/** 按文件头认音频类型（服务商的 content-type 有时不准，例如中转统一标成 application/octet-stream） */
export function sniffAudioMime(bytes: Uint8Array, fallback = 'audio/mpeg'): string {
  const b = bytes;
  const s = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'audio/wav';
  if (b.length >= 3 && s(0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) return (b[1] ?? 0) & 0x06 ? 'audio/mpeg' : 'audio/aac';
  if (b.length >= 4 && s(0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 4 && s(0, 4) === 'fLaC') return 'audio/flac';
  if (b.length >= 8 && s(4, 4) === 'ftyp') return 'audio/mp4';
  return fallback;
}

/** 收到的是 JSON（有的中转出错也回 200）就当错误处理 */
async function audioOrError(res: Response, provider: string, format: AudioFormat): Promise<{ bytes: Bytes; mime: string }> {
  const type = res.headers.get('content-type') ?? '';
  if (/json|text\/(?:plain|html)/i.test(type)) {
    const body = await readText(res);
    throw httpError(provider, res.status === 200 ? 502 : res.status, body);
  }
  const bytes = await readBytes(res);
  if (bytes.length < 64) throw new AiError('empty', `${provider} 返回的音频是空的`, { retryable: true });
  return { bytes, mime: sniffAudioMime(bytes, MIME[format]) };
}

/** 硅基流动的系统音色可以只写名字，程序补成 "模型:音色" */
const SILICONFLOW_VOICES = new Set(['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana']);

/**
 * OpenAI 兼容：POST …/audio/speech（OpenAI、硅基流动 CosyVoice、各家中转）。
 * - CosyVoice：情绪和风格用一句中文指令放在正文前（"请用害羞的语气说<|endofprompt|>…"，硅基流动文档里的写法）；
 *   连接的 extra.emotion = 'off' 时不加。
 * - gpt-4o-mini-tts：情绪和风格放 instructions。
 */
export async function openaiSpeech(ep: Endpoint, call: TtsCall): Promise<TtsOutput> {
  const { req } = call;
  const model = req.voice.model || ep.model;
  const format = req.format ?? 'mp3';
  let voice = req.voice.voiceId;
  if (model.includes('/') && SILICONFLOW_VOICES.has(voice.toLowerCase())) voice = `${model}:${voice.toLowerCase()}`;
  let input = call.text;
  const body: Record<string, unknown> = { model, voice, response_format: format };
  if (req.voice.speed && req.voice.speed !== 1) body.speed = req.voice.speed;
  const emotionZh = emotionInChinese(call.emotion);
  const style = req.voice.style?.trim();
  if (/cosyvoice/i.test(model) && ep.extra?.emotion !== 'off' && (emotionZh || style)) {
    const how = [emotionZh ? `${emotionZh}的语气` : '', style ?? ''].filter(Boolean).join('，');
    input = `请用${how}说<|endofprompt|>${input}`;
  } else if (/gpt-4o.*tts/i.test(model) && (call.emotion || style)) {
    body.instructions = [call.emotion ? `Emotion: ${call.emotion}.` : '', style ?? ''].filter(Boolean).join(' ');
  }
  body.input = input;
  const url = joinUrl(openaiBase(ep.baseUrl), 'audio/speech');
  const send = () => request(transportOf(ep), ep.name, url, { method: 'POST', headers: bearerHeaders(ep), body: JSON.stringify(body), signal: req.signal });
  const { response, errText } = await sendFixing(url, undefined, undefined, send, [
    dropField(body, 'instructions', /instructions/i),
    dropField(body, 'speed', /speed/i),
  ]);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  return { ...(await audioOrError(response, ep.name, format)), model };
}

/**
 * MiniMax：POST {base}/t2a_v2（国内 https://api.minimaxi.com/v1，海外 https://api.minimax.io/v1）。
 * 老账号要在 URL 上带 GroupId（连接的 extra.groupId）。返回 JSON，音频是十六进制字符串。
 */
export async function minimaxSpeech(ep: Endpoint, call: TtsCall): Promise<TtsOutput> {
  const { req } = call;
  const model = req.voice.model || ep.model || 'speech-02-hd';
  const format = req.format === 'wav' || req.format === 'flac' || req.format === 'pcm' ? req.format : 'mp3';
  const voiceSetting: Record<string, unknown> = { voice_id: req.voice.voiceId, speed: req.voice.speed ?? 1, vol: req.voice.volume ?? 1, pitch: Math.round(req.voice.pitch ?? 0) };
  const emotion = minimaxEmotion(call.emotion);
  if (emotion) voiceSetting.emotion = emotion;
  const body = {
    model,
    text: call.text,
    stream: false,
    voice_setting: voiceSetting,
    audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 },
    language_boost: 'auto',
    output_format: 'hex',
  };
  const base = trimUrl(ep.baseUrl || 'https://api.minimaxi.com/v1').replace(/\/t2a_v2$/i, '');
  const group = ep.extra?.groupId ? `?GroupId=${encodeURIComponent(ep.extra.groupId)}` : '';
  const url = `${joinUrl(base, 't2a_v2')}${group}`;
  const send = () => request(transportOf(ep), ep.name, url, { method: 'POST', headers: bearerHeaders(ep), body: JSON.stringify(body), signal: req.signal });
  const { response, errText } = await sendFixing(url, undefined, undefined, send, [dropField(voiceSetting, 'emotion', /emotion/i)]);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  const text = await readText(response);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiError('bad_response', `${ep.name} 的回复看不懂：${text.slice(0, 200)}`, { retryable: true });
  }
  const code = data?.base_resp?.status_code;
  if (code !== undefined && code !== 0) {
    // 1004 鉴权失败、1008 余额不足、2013 参数错误……
    throw new AiError('http', `${ep.name} 返回错误 ${code}：${data.base_resp.status_msg ?? ''}`, { status: code === 1004 ? 401 : code === 1008 ? 402 : 400, detail: text.slice(0, 2000) });
  }
  const hex = data?.data?.audio;
  if (typeof hex !== 'string' || !hex) throw new AiError('empty', `${ep.name} 没有返回音频`, { retryable: true });
  const bytes = new Uint8Array(hexToBytes(hex));
  return { bytes, mime: sniffAudioMime(bytes, MIME[format]), model };
}

/**
 * Fish Audio：POST https://api.fish.audio/v1/tts，模型放在 model 请求头（s1 / speech-1.6 / speech-1.5），
 * voiceId 是音色模型页上的 reference_id。S1 支持在正文前加情绪标记。
 */
export async function fishSpeech(ep: Endpoint, call: TtsCall): Promise<TtsOutput> {
  const { req } = call;
  const model = req.voice.model || ep.model || 's1';
  const format = req.format === 'wav' || req.format === 'opus' || req.format === 'pcm' ? req.format : 'mp3';
  const marker = /^s1/i.test(model) ? fishEmotion(call.emotion) : undefined;
  const body: Record<string, unknown> = {
    text: marker ? `(${marker}) ${call.text}` : call.text,
    reference_id: req.voice.voiceId || undefined,
    format,
    mp3_bitrate: 128,
    normalize: true,
    latency: 'normal',
    prosody: { speed: req.voice.speed ?? 1, volume: 0 },
  };
  const base = trimUrl(ep.baseUrl || 'https://api.fish.audio').replace(/\/(?:v1\/)?tts$/i, '').replace(/\/v1$/i, '');
  const url = joinUrl(base, 'v1/tts');
  const res = await request(transportOf(ep), ep.name, url, {
    method: 'POST',
    headers: { ...bearerHeaders(ep), model },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  return { ...(await audioOrError(res, ep.name, format)), model };
}

/**
 * 自建 GPT-SoVITS（api_v2.py）：POST {base}/tts。voiceId 是参考音频在服务器上的路径，
 * refText / refLang 是参考音频里说的话和语言。一般不需要 Key（有的话按 Bearer 带上）。
 */
export async function sovitsSpeech(ep: Endpoint, call: TtsCall): Promise<TtsOutput> {
  const { req } = call;
  // api_v2 的 media_type 只有 wav / raw / ogg / aac，没有 mp3
  const format: 'wav' | 'aac' | 'pcm' = req.format === 'aac' ? 'aac' : req.format === 'pcm' ? 'pcm' : 'wav';
  const body = {
    text: call.text,
    text_lang: req.language || guessLanguage(call.text),
    ref_audio_path: req.voice.voiceId,
    prompt_text: req.voice.refText ?? '',
    prompt_lang: req.voice.refLang || 'zh',
    text_split_method: 'cut5',
    batch_size: 1,
    media_type: format === 'pcm' ? 'raw' : format,
    streaming_mode: false,
    speed_factor: req.voice.speed ?? 1,
  };
  const url = joinUrl(trimUrl(ep.baseUrl).replace(/\/tts$/i, ''), 'tts');
  const res = await request(transportOf(ep), ep.name, url, { method: 'POST', headers: bearerHeaders(ep), body: JSON.stringify(body), signal: req.signal });
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  return { ...(await audioOrError(res, ep.name, format)), model: ep.model || 'gpt-sovits' };
}
