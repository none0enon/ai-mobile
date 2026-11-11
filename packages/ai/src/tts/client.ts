import type { ConnectionKind } from '@app/shared';
import type { Endpoint } from '../core/endpoint.ts';
import { AiError } from '../core/errors.ts';
import { hashString } from '../core/util.ts';
import { resolveEmotion } from './emotion.ts';
import { fishSpeech, minimaxSpeech, openaiSpeech, sovitsSpeech, type TtsCall, type TtsOutput } from './providers.ts';
import { prepareTtsText } from './text.ts';
import type { TtsAudio, TtsRequest } from './types.ts';
import { volcengineSpeech } from './volcengine.ts';

const TTS_PROVIDERS: Partial<Record<ConnectionKind, (ep: Endpoint, call: TtsCall) => Promise<TtsOutput>>> = {
  openai: openaiSpeech,
  minimax: minimaxSpeech,
  volcengine: volcengineSpeech,
  'fish-audio': fishSpeech,
  'gpt-sovits': sovitsSpeech,
};

export function canSpeak(kind: ConnectionKind): boolean {
  return !!TTS_PROVIDERS[kind];
}

/** 实际要读的文字和情绪（缓存的键、合成都用它） */
export function ttsInput(req: TtsRequest): { text: string; emotion: string | null } {
  return {
    text: req.raw ? req.text.trim() : prepareTtsText(req.text, { ...req.textOptions, speakerName: req.speakerName }),
    emotion: resolveEmotion(req.expression, req.voice.emotionMap),
  };
}

/** 同一个连接、模型、音色、情绪、语速读同一句话，结果一样：按这些算缓存的键 */
export function ttsCacheKey(ep: Endpoint, req: TtsRequest): string {
  const { text, emotion } = ttsInput(req);
  const v = req.voice;
  return `tts:${hashString([ep.kind, ep.baseUrl, v.model || ep.model, v.voiceId, emotion ?? '', v.speed ?? 1, v.pitch ?? 0, v.style ?? '', req.format ?? '', text].join('\u0001'))}`;
}

/** 合成一句话。文字先去掉控制标签、动作描写和表情符号；去完没字可读时报错 */
export async function synthesize(ep: Endpoint, req: TtsRequest): Promise<TtsAudio> {
  const provider = TTS_PROVIDERS[ep.kind];
  if (!provider) throw new AiError('unsupported', `"${ep.name}" 是 ${ep.kind} 连接，不能合成语音`);
  const { text, emotion } = ttsInput(req);
  if (!text) throw new AiError('empty', '去掉动作描写和表情符号后没有要读的字');
  if (!req.voice.voiceId && ep.kind !== 'fish-audio') throw new AiError('no_route', '还没给这个角色选音色');
  const out = await provider(ep, { text, emotion, req });
  return { ...out, provider: ep.kind, voiceId: req.voice.voiceId, emotion, text };
}
