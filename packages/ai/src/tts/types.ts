import type { ConnectionKind, TtsTextOptions } from '@app/shared';
import type { Bytes } from '../core/http.ts';

/**
 * 音色（由角色的 CharacterVoice 转过来）。voiceId 在各家的含义不同：
 * OpenAI 兼容的 voice、MiniMax 的 voice_id、Fish Audio 的 reference_id、GPT-SoVITS 的参考音频路径。
 */
export interface VoiceSpec {
  voiceId: string;
  /** 这个角色单独用的模型；为空时用"语音合成"功能设置里的模型 */
  model?: string;
  /** 1 为正常语速 */
  speed?: number;
  /** MiniMax 的音调（-12～12） */
  pitch?: number;
  /** 1 为正常音量 */
  volume?: number;
  /** 基础说话风格（CosyVoice 指令、gpt-4o-mini-tts 的 instructions） */
  style?: string;
  /** 仅 GPT-SoVITS：参考音频的文字和语言 */
  refText?: string;
  refLang?: string;
  /** 表情 → 情绪的覆盖 */
  emotionMap?: Record<string, string>;
}

export type AudioFormat = 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';

export interface TtsRequest {
  text: string;
  voice: VoiceSpec;
  /** 这句话说出来时的表情（smile、sad…），映射成情绪参数 */
  expression?: string | null;
  format?: AudioFormat;
  /** zh / ja / en；为空时按文字猜 */
  language?: string;
  /** 文字已经处理过（不再去掉动作描写、表情符号） */
  raw?: boolean;
  /** 朗读前怎么处理文字（只读引号里的、动作读不读……），不给用默认 */
  textOptions?: TtsTextOptions;
  /** 说话人的名字：行首的"名字："不读 */
  speakerName?: string;
  signal?: AbortSignal;
}

export interface TtsAudio {
  bytes: Bytes;
  mime: string;
  provider: ConnectionKind;
  model: string;
  voiceId: string;
  emotion: string | null;
  /** 实际读的文字（去掉动作描写之后） */
  text: string;
}
