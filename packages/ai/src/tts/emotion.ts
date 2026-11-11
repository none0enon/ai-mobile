/**
 * 表情 → 情绪（设计文档 §11.1"表情映射成情绪参数"）。
 * 先用角色自己的 emotionMap（CharacterVoice.emotionMap，例如 { blush: 'shy' }），没写的用这里的默认值；
 * 得到一个通用情绪词，再按各家支持的写法翻译。平静 / 没有表情时不传情绪，让模型按文字自己判断。
 */
export type Emotion =
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'fearful'
  | 'disgusted'
  | 'calm'
  | 'shy'
  | 'gentle'
  | 'whisper'
  | 'sleepy'
  | 'playful';

export const DEFAULT_EMOTION_MAP: Record<string, Emotion> = {
  smile: 'happy',
  laugh: 'happy',
  blush: 'shy',
  shy: 'shy',
  pout: 'playful',
  surprised: 'surprised',
  sad: 'sad',
  angry: 'angry',
  sleepy: 'sleepy',
  sleep: 'whisper',
};

/** 这一句用什么情绪；表情为空或平静时返回 null */
export function resolveEmotion(expression: string | null | undefined, custom?: Record<string, string>): string | null {
  if (!expression || expression === 'neutral') return null;
  return custom?.[expression] || DEFAULT_EMOTION_MAP[expression] || null;
}

/** MiniMax 的 emotion 参数只认这几个；其余（害羞、撒娇……）不传，模型按文字自己判断 */
const MINIMAX: Record<string, string> = {
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  surprised: 'surprised',
  fearful: 'fearful',
  disgusted: 'disgusted',
  calm: 'calm',
  gentle: 'calm',
  sleepy: 'calm',
  whisper: 'calm',
};
export function minimaxEmotion(emotion: string | null): string | undefined {
  return emotion ? MINIMAX[emotion] : undefined;
}

/** CosyVoice 用一句中文指令控制情绪："请用害羞的语气说<|endofprompt|>正文" */
const COSYVOICE_ZH: Record<string, string> = {
  happy: '开心',
  sad: '难过',
  angry: '生气',
  surprised: '惊讶',
  fearful: '害怕',
  disgusted: '嫌弃',
  calm: '平静',
  shy: '害羞',
  gentle: '温柔',
  whisper: '很轻、像在耳边小声说话',
  sleepy: '困倦、慵懒',
  playful: '撒娇',
};
export function emotionInChinese(emotion: string | null): string | undefined {
  if (!emotion) return undefined;
  // emotionMap 里也可以直接写中文
  return COSYVOICE_ZH[emotion] ?? (/[\u4e00-\u9fff]/.test(emotion) ? emotion : undefined);
}

/** Fish Audio S1 在正文前加情绪标记，如 "(embarrassed) …" */
const FISH: Record<string, string> = {
  happy: 'joyful',
  sad: 'sad',
  angry: 'angry',
  surprised: 'surprised',
  fearful: 'scared',
  disgusted: 'disgusted',
  calm: 'relaxed',
  shy: 'embarrassed',
  gentle: 'soft tone',
  whisper: 'whispering',
  sleepy: 'soft tone',
  playful: 'delighted',
};
export function fishEmotion(emotion: string | null): string | undefined {
  return emotion ? FISH[emotion] : undefined;
}
