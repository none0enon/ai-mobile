import type { ConnectionKind } from '@app/shared';
import { bearerHeaders, joinUrl, openaiBase, transportOf, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError, responseContext, throwIfAborted } from '../core/errors.ts';
import { readText, request } from '../core/http.ts';

export interface SttRequest {
  audio: Blob;
  filename?: string;
  signal?: AbortSignal;
}

export function canTranscribe(kind: ConnectionKind): boolean {
  return kind === 'openai';
}

function audioFilename(audio: Blob): string {
  const mime = audio.type.split(';')[0]?.toLowerCase();
  const ext: Record<string, string> = {
    'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
  };
  return `recording.${ext[mime ?? ''] ?? 'webm'}`;
}

/** OpenAI 兼容的文件转录接口（硅基流动 SenseVoice 等）。浏览器负责 multipart boundary。 */
export async function transcribeAudio(ep: Endpoint, req: SttRequest): Promise<{ text: string }> {
  throwIfAborted(req.signal);
  if (!canTranscribe(ep.kind)) throw new AiError('unsupported', `${ep.name}不支持语音识别`);
  if (!req.audio.size) throw new AiError('empty', '没有录到音频，请重新按住说话');
  const body = new FormData();
  body.append('model', ep.model);
  body.append('file', req.audio, req.filename ?? audioFilename(req.audio));
  const headers = new Headers(bearerHeaders(ep, false));
  // 自定义请求头里也可能留着 application/json，不能覆盖 FormData 自动生成的 boundary。
  headers.delete('Content-Type');
  const res = await request(transportOf(ep), ep.name, joinUrl(openaiBase(ep.baseUrl), 'audio/transcriptions'), {
    method: 'POST', headers, body, signal: req.signal,
  });
  const raw = await readText(res);
  throwIfAborted(req.signal);
  if (!res.ok) throw httpError(ep.name, res.status, raw, res);
  let data: unknown;
  try { data = JSON.parse(raw); } catch { /* 在下面统一给出完整响应 */ }
  if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string') {
    throw new AiError('bad_response', `${ep.name}没有返回语音识别文字`, { detail: raw, context: responseContext(res) });
  }
  // 静音可以合法返回空文字；调用方决定提示重录，连接测试也能据此验证接口。
  return { text: data.text.trim() };
}

/** 连接测试使用本地生成的 1 秒、16 kHz 单声道 PCM 静音，不申请麦克风权限。 */
export function sttTestAudio(): Blob {
  const bytes = new Uint8Array(44 + 16000 * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, bytes.length - 44, true);
  return new Blob([bytes], { type: 'audio/wav' });
}
