import { utf8Decode } from './bytes.ts';
import { looksLikeCard } from './card.ts';
import { looksLikeLorebook } from './lorebook.ts';
import { isPng } from './png.ts';
import { looksLikePreset } from './preset.ts';

export * from './bytes.ts';
export * from './png.ts';
export * from './card.ts';
export * from './lorebook.ts';
export * from './preset.ts';
export * from './macros.ts';
export * from './tokens.ts';
export * from './worldinfo.ts';
export * from './assemble.ts';

export type StFileKind = 'card' | 'lorebook' | 'preset' | 'chat' | 'unknown';

/** 读出文件内容后判断是哪种 SillyTavern 文件（PNG 一律当角色卡） */
export function detectStFile(bytes: Uint8Array, fileName = ''): { kind: StFileKind; json?: unknown } {
  if (isPng(bytes)) return { kind: 'card' };
  const text = utf8Decode(bytes).replace(/^﻿/, '');
  if (/\.jsonl$/i.test(fileName)) return { kind: 'chat' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // .jsonl 聊天记录：每行一个 JSON
    const first = text.split('\n')[0] ?? '';
    try {
      const head = JSON.parse(first) as Record<string, unknown>;
      if (head && ('chat_metadata' in head || 'user_name' in head)) return { kind: 'chat' };
    } catch {
      // 不是 JSON
    }
    return { kind: 'unknown' };
  }
  if (looksLikeCard(json)) return { kind: 'card', json };
  if (looksLikePreset(json)) return { kind: 'preset', json };
  if (looksLikeLorebook(json)) return { kind: 'lorebook', json };
  return { kind: 'unknown', json };
}
