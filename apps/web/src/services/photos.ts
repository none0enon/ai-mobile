import type { Character } from '@app/shared';
import { assetUrl } from './assets';
import { useAiStore } from '@/stores/ai';
import { seedBlockContent, useLibraryStore } from '@/stores/library';
import { toBase64 } from '@/utils/image';

/**
 * 聊天里发给她的照片（＋ → 相册 / 拍照）：先交给"识图"看一遍，写成一段描述，
 * 提示词里用这段描述代替照片（[照片：…]），所以主对话用不能看图的模型也行，之后的每一轮、总结、主动消息也都知道照片里有什么。
 * 怎么看（说明文字）在对话预设的"识图看照片"一块里（自带的对话预设都有，能改）；导入的 SillyTavern 预设没有这一块时用自带预设文件里的。
 */

export class PhotoNotConnected extends Error {
  constructor(reason: string) {
    super(`识图还没接通：${reason}`);
    this.name = 'PhotoNotConnected';
  }
}

/** 这个角色的对话预设里"识图看照片"那一块；没有就用自带预设文件里的 */
export function photoInstruction(character: Character | undefined): string {
  const own = useLibraryStore().chatPresetFor(character)?.blocks.find((b) => b.identifier === 'photoLook')?.content.trim();
  const text = own || seedBlockContent('photoLook');
  if (!text) throw new Error('预设里没有"识图看照片"这一块');
  return text;
}

/** 识图看这张照片（本机素材库里的），返回描述和模型 */
export async function describePhoto(assetKey: string, character: Character | undefined, signal?: AbortSignal): Promise<{ text: string; model: string }> {
  return lookWith(assetKey, photoInstruction(character), signal);
}

/**
 * 识图按给定的说明看这张照片（本机素材库里的），返回原文和模型。
 * 一起吃饭看饭照时说明在"一起吃饭"功能预设的"识图看饭照"那一块里（services/photos.ts 只管调用）
 */
export async function lookWith(assetKey: string, instruction: string, signal?: AbortSignal): Promise<{ text: string; model: string }> {
  const ai = useAiStore();
  const st = ai.status('vision');
  if (!st.live) throw new PhotoNotConnected(st.reason);
  const url = await assetUrl(assetKey);
  if (!url) throw new Error('本机找不到这张照片了');
  const blob = await fetch(url).then((r) => r.blob());
  const data = toBase64(new Uint8Array(await blob.arrayBuffer()));
  const r = await ai.system.chat(
    'vision',
    { messages: [{ role: 'user', content: [{ type: 'image', mime: blob.type || 'image/jpeg', data }, { type: 'text', text: instruction }] }], maxTokens: 800 },
    { signal },
  );
  const text = r.text.trim();
  if (!text) throw new Error('识图返回了空的描述');
  return { text, model: r.model };
}
