import { SCENES, type SceneId } from './scenes.ts';
import type { PresetCategory } from './types/preset.ts';

/**
 * 用预设的地方：每个调用 AI 的功能用哪一类预设。
 * - 对话：每个角色自己选（Character.presetId），不在这张表里；
 * - 一起做事的每件事（scene:meal 等）、主动消息：选一个对应分类的预设，或者"跟随对话预设"（用这个角色的对话预设）；
 * - 小剧场（番外）、总结、生图提示词：选一个对应分类的预设。
 */
export type FeatureSceneId = Exclude<SceneId, 'free'>;
export type PresetUseId = 'proactive' | 'theater' | 'summary' | 'image' | `scene:${FeatureSceneId}`;

export interface PresetUse {
  id: PresetUseId;
  category: PresetCategory;
  label: string;
  desc: string;
  icon: string;
  /** 可以选"跟随对话预设" */
  followChat: boolean;
}

export const PRESET_USES: PresetUse[] = [
  ...SCENES.map((s): PresetUse => ({ id: `scene:${s.id as FeatureSceneId}`, category: 'feature', label: s.name, desc: `${s.name}时的对话`, icon: s.icon, followChat: true })),
  { id: 'proactive', category: 'proactive', label: '主动消息', desc: '到点时角色先发来的那条', icon: 'i-lucide-bell-ring', followChat: true },
  { id: 'theater', category: 'theater', label: '番外', desc: '"我的 → 试一试 → 写一段番外"', icon: 'i-lucide-book-heart', followChat: false },
  { id: 'summary', category: 'summary', label: '总结聊天', desc: '攒够 30 条自动整理，聊天 ⋯ 里也能手动整理', icon: 'i-lucide-notebook-pen', followChat: false },
  { id: 'image', category: 'image', label: '配图', desc: '聊天 ＋ → 生成配图、聊天里的 [cg:]、番外的那一幕：先写成 NovelAI tags 再调生图 API', icon: 'i-lucide-image', followChat: false },
];

export function presetUse(id: PresetUseId): PresetUse | undefined {
  return PRESET_USES.find((u) => u.id === id);
}

/** 在这个场景里对话用哪个用途（自由聊天没有，用对话预设） */
export function sceneUse(sceneId: string | null | undefined): PresetUseId | null {
  return sceneId && SCENES.some((s) => s.id === sceneId) ? (`scene:${sceneId}` as PresetUseId) : null;
}
