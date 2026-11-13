import { samplerRequest } from '@app/ai';
import { assembleTaskPrompt, type Character } from '@app/shared';
import { useAiStore } from '@/stores/ai';
import { useLibraryStore } from '@/stores/library';
import type { Novel, NovelChapter } from '@/stores/workshop';
import { MissingPresetError } from './prompt';

/**
 * 创意工坊 · 写小说（设计文档 §9.11）：用"小说"预设（用途 novel），调"创作 · 小说"的 API。
 * 预设里每件事一块（商量 novel-chat、写下一章 novel-chapter、写番外 novel-extra、重写 novel-rewrite），按这次做的事只发那一块；
 * 这里只填这一次的输入：作品、写好的章节、最近的讨论、这一次要做的。
 */
export type NovelTask = 'novel-chat' | 'novel-chapter' | 'novel-extra' | 'novel-rewrite';

/** 前文最多带多少字（从最新的一章往前，带得下就带全文，带不下的只带标题和开头） */
const CONTEXT_CHARS = 24_000;
/** 讨论最多带最近几条 */
const TALK_KEEP = 16;
export const NOTE_MARK = '【记进设定】';

export interface NovelCallOptions {
  /** 她的名字（预设里的 {{char}}）和你的名字（{{user}}） */
  character?: Pick<Character, 'name' | 'presetId'> | null;
  userName: string;
  signal?: AbortSignal;
  onText?(text: string): void;
}

export function novelStatus(): { live: boolean; reason: string } {
  const s = useAiStore().status('novel');
  return s.live ? { live: true, reason: '' } : { live: false, reason: `「创作 · 小说」还没接通：${s.reason}` };
}

/** 第几章（只算正文，不算番外） */
export function chapterNo(novel: Novel, chapter?: NovelChapter): number {
  const main = novel.chapters.filter((c) => c.kind === 'chapter');
  if (!chapter) return main.length + 1;
  return main.findIndex((c) => c.id === chapter.id) + 1;
}

export function chapterLabel(novel: Novel, chapter: NovelChapter): string {
  if (chapter.kind === 'extra') return `番外 · ${chapter.title || '无题'}`;
  return `第 ${chapterNo(novel, chapter)} 章 · ${chapter.title || '无题'}`;
}

function infoText(n: Novel): string {
  return [
    `书名：《${n.title}》`,
    n.genre.trim() ? `类型：${n.genre.trim()}` : '',
    n.setting.trim() ? `设定和人物：\n${n.setting.trim()}` : '设定和人物：还没写，按讨论里说过的来',
    n.outline.trim() ? `大纲：\n${n.outline.trim()}` : '',
    n.style.trim() ? `文风和尺度：${n.style.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 已经写好的章节：从最新的往前带全文，带不下的只带标题和开头；番外只在重写它时带全文 */
function chaptersText(n: Novel, skip?: string): string {
  const list = n.chapters.filter((c) => c.id !== skip);
  if (!list.length) return '已经写好的章节：还没有，这是第一章。';
  let budget = CONTEXT_CHARS;
  const parts: string[] = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const c = list[i]!;
    const head = chapterLabel(n, c);
    if (c.kind === 'chapter' && c.text.length <= budget) {
      parts.unshift(`【${head}】\n${c.text.trim()}`);
      budget -= c.text.length;
    } else {
      parts.unshift(`【${head}】（只给开头）${c.text.trim().replace(/\s+/g, ' ').slice(0, 120)}…`);
    }
  }
  return `已经写好的章节（按顺序）：\n\n${parts.join('\n\n')}`;
}

function talkText(n: Novel, userName: string): string {
  const recent = n.talk.slice(-TALK_KEEP);
  if (!recent.length) return '';
  const who = (r: string) => (r === 'user' ? userName : '你');
  return `你们最近的讨论：\n${recent.map((t) => `${who(t.role)}：${t.text.length > 800 ? `${t.text.slice(0, 800)}…` : t.text}`).join('\n')}`;
}

/** 写作助手的回复里拿出【记进设定】的几行 */
export function splitNotes(text: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const rest = text
    .split('\n')
    .filter((line) => {
      const i = line.indexOf(NOTE_MARK);
      if (i < 0) return true;
      const note = line.slice(i + NOTE_MARK.length).replace(/^[：:\s]+/, '').trim();
      if (note) notes.push(note);
      return false;
    })
    .join('\n')
    .trim();
  return { text: rest, notes };
}

/** 章节输出：第一行"# 标题"，空一行，正文（流式时也能边写边分） */
export function parseChapter(raw: string): { title: string; text: string } {
  const s = raw.replace(/\r/g, '').replace(/^\s+/, '');
  const m = /^#+\s*(.*)\n?/.exec(s);
  if (!m) return { title: '', text: s.trim() };
  const title = (m[1] ?? '')
    .replace(/^(第\s*[0-9一二三四五六七八九十百千]+\s*章|番外)\s*[：:·\-—\s]*/, '')
    .replace(/^[《「]|[》」]$/g, '')
    .trim();
  return { title, text: s.slice(m[0].length).trim() };
}

async function run(novel: Novel, task: NovelTask, ask: string, opts: NovelCallOptions, skip?: string): Promise<string> {
  const status = novelStatus();
  if (!status.live) throw new Error(status.reason);
  const preset = useLibraryStore().presetForUse('novel', opts.character);
  if (!preset) throw new MissingPresetError('小说');
  const { messages } = assembleTaskPrompt({
    preset,
    fills: {
      novelInfo: infoText(novel),
      novelChapters: chaptersText(novel, skip),
      novelChat: talkText(novel, opts.userName),
      novelAsk: ask,
    },
    macros: { char: opts.character?.name ?? '', user: opts.userName },
    type: task,
  });
  const stream = preset.sampler.stream !== false && !!opts.onText;
  const r = await useAiStore().system.chat(
    'novel',
    { messages, ...samplerRequest(preset.sampler) },
    { signal: opts.signal, ...(stream ? { onDelta: (t: string) => opts.onText?.(t) } : {}) },
  );
  return r.text;
}

/** 和写作助手商量：你说一句，它回一段（最后可能带几条【记进设定】） */
export async function novelChat(novel: Novel, said: string, opts: NovelCallOptions): Promise<{ text: string; notes: string[] }> {
  const raw = await run(novel, 'novel-chat', `${opts.userName}刚说：${said}`, { ...opts, onText: opts.onText ? (t) => opts.onText?.(splitNotes(t).text) : undefined });
  return splitNotes(raw);
}

/** 写下一章 / 写番外 */
export async function novelWrite(novel: Novel, kind: 'chapter' | 'extra', wish: string, opts: NovelCallOptions): Promise<{ title: string; text: string }> {
  const w = wish.trim();
  const ask =
    kind === 'chapter'
      ? `写第 ${chapterNo(novel)} 章。${w ? `${opts.userName}的要求：${w}` : `${opts.userName}没有额外要求，照大纲和讨论接着写。`}`
      : `写一篇番外。${w ? `${opts.userName}想要的番外：${w}` : `${opts.userName}没说想要什么样的，你来挑一个有意思的。`}`;
  const raw = await run(novel, kind === 'chapter' ? 'novel-chapter' : 'novel-extra', ask, opts);
  return parseChapter(raw);
}

/** 照你的意见重写一章 */
export async function novelRewrite(novel: Novel, chapter: NovelChapter, wish: string, opts: NovelCallOptions): Promise<{ title: string; text: string }> {
  const ask = [
    `重写【${chapterLabel(novel, chapter)}】。`,
    `${opts.userName}的意见：${wish.trim() || '整体再打磨一下，写得更好看'}`,
    `原文：\n# ${chapter.title}\n\n${chapter.text}`,
  ].join('\n');
  const raw = await run(novel, 'novel-rewrite', ask, opts, chapter.id);
  return parseChapter(raw);
}
