import { defineStore } from 'pinia';
import { ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { uid } from '@/utils/id';

/**
 * 一起游戏 · 创意工坊的存档：你写的小说（和写作助手的讨论、写好的章节和番外）、你画的画。
 * 作品是你自己的，不分角色：哪个角色都能拿给她看。存在本机（settings 表的 workshop），画本身在素材库里。
 */
export interface NovelChapter {
  id: string;
  /** chapter 正文的一章；extra 番外 */
  kind: 'chapter' | 'extra';
  title: string;
  text: string;
  at: number;
}

export interface NovelTalk {
  role: 'user' | 'assistant';
  text: string;
  /** 助手这一次建议记进设定的几条（【记进设定】） */
  notes?: string[];
  at: number;
}

export interface Novel {
  id: string;
  title: string;
  /** 类型：校园、仙侠、悬疑…… */
  genre: string;
  /** 设定和人物 */
  setting: string;
  /** 大纲 */
  outline: string;
  /** 文风、视角、尺度 */
  style: string;
  chapters: NovelChapter[];
  talk: NovelTalk[];
  createdAt: number;
  updatedAt: number;
}

export interface Drawing {
  id: string;
  title: string;
  /** 你写的画面描述 */
  caption: string;
  /** her 画她（加她的长相）；free 自由画 */
  who: 'her' | 'free';
  size: 'portrait' | 'landscape' | 'square';
  /** 画的是哪部小说里的一幕 */
  novelId?: string;
  /** 画她时画的是哪个角色 */
  characterId?: string;
  assetKey: string | null;
  url?: string;
  prompt: string;
  negative: string;
  seed: number | null;
  model: string;
  at: number;
}

interface Saved {
  novels: Novel[];
  drawings: Drawing[];
}

const KEY = 'workshop';
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function parseNovel(v: unknown): Novel | null {
  const o = v as Partial<Novel> | null;
  if (!o || typeof o !== 'object' || typeof o.id !== 'string') return null;
  const chapters = (Array.isArray(o.chapters) ? o.chapters : [])
    .filter((c): c is NovelChapter => !!c && typeof c.id === 'string' && typeof c.text === 'string')
    .map((c) => ({ id: c.id, kind: c.kind === 'extra' ? ('extra' as const) : ('chapter' as const), title: str(c.title), text: c.text, at: num(c.at, Date.now()) }));
  const talk = (Array.isArray(o.talk) ? o.talk : [])
    .filter((t): t is NovelTalk => !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
    .map((t) => ({ role: t.role, text: t.text, ...(Array.isArray(t.notes) && t.notes.length ? { notes: t.notes.filter((n) => typeof n === 'string') } : {}), at: num(t.at, Date.now()) }));
  return {
    id: o.id,
    title: str(o.title) || '未命名',
    genre: str(o.genre),
    setting: str(o.setting),
    outline: str(o.outline),
    style: str(o.style),
    chapters,
    talk,
    createdAt: num(o.createdAt, Date.now()),
    updatedAt: num(o.updatedAt, Date.now()),
  };
}

function parseDrawing(v: unknown): Drawing | null {
  const o = v as Partial<Drawing> | null;
  if (!o || typeof o !== 'object' || typeof o.id !== 'string') return null;
  if (!o.assetKey && !o.url) return null;
  return {
    id: o.id,
    title: str(o.title) || '无题',
    caption: str(o.caption),
    who: o.who === 'her' ? 'her' : 'free',
    size: o.size === 'landscape' || o.size === 'square' ? o.size : 'portrait',
    ...(typeof o.novelId === 'string' ? { novelId: o.novelId } : {}),
    ...(typeof o.characterId === 'string' ? { characterId: o.characterId } : {}),
    assetKey: typeof o.assetKey === 'string' ? o.assetKey : null,
    ...(typeof o.url === 'string' ? { url: o.url } : {}),
    prompt: str(o.prompt),
    negative: str(o.negative),
    seed: typeof o.seed === 'number' ? o.seed : null,
    model: str(o.model),
    at: num(o.at, Date.now()),
  };
}

export const useWorkshopStore = defineStore('workshop', () => {
  const novels = ref<Novel[]>([]);
  const drawings = ref<Drawing[]>([]);
  const saver = autoSave('settings', () => [{ key: KEY, value: { novels: novels.value, drawings: drawings.value } satisfies Saved }], () => [novels.value, drawings.value], 800);

  async function hydrate() {
    const saved = await getOne<Partial<Saved>>('settings', KEY);
    novels.value = (Array.isArray(saved?.novels) ? saved.novels : []).map(parseNovel).filter((n): n is Novel => !!n);
    drawings.value = (Array.isArray(saved?.drawings) ? saved.drawings : []).map(parseDrawing).filter((d): d is Drawing => !!d);
    saver.start();
  }

  function novelById(id: string | null | undefined): Novel | undefined {
    return novels.value.find((n) => n.id === id);
  }

  function createNovel(init: Partial<Pick<Novel, 'title' | 'genre' | 'setting' | 'outline' | 'style'>> = {}): Novel {
    const now = Date.now();
    const n: Novel = { id: uid('novel'), title: init.title?.trim() || '未命名', genre: init.genre ?? '', setting: init.setting ?? '', outline: init.outline ?? '', style: init.style ?? '', chapters: [], talk: [], createdAt: now, updatedAt: now };
    novels.value.unshift(n);
    return novels.value[0]!;
  }

  function updateNovel(id: string, patch: Partial<Pick<Novel, 'title' | 'genre' | 'setting' | 'outline' | 'style'>>) {
    const n = novelById(id);
    if (!n) return;
    Object.assign(n, patch, { updatedAt: Date.now() });
  }

  function removeNovel(id: string) {
    novels.value = novels.value.filter((n) => n.id !== id);
  }

  function addTalk(id: string, talk: Omit<NovelTalk, 'at'>) {
    const n = novelById(id);
    if (!n) return;
    n.talk.push({ ...talk, at: Date.now() });
    // 讨论只留最近的 200 条（提示词里只带最近十几条）
    if (n.talk.length > 200) n.talk.splice(0, n.talk.length - 200);
    n.updatedAt = Date.now();
  }

  function clearTalk(id: string) {
    const n = novelById(id);
    if (n) n.talk = [];
  }

  /** 把一条设定记进"设定"（另起一行） */
  function addNote(id: string, note: string) {
    const n = novelById(id);
    if (!n || !note.trim()) return;
    n.setting = n.setting.trim() ? `${n.setting.trim()}\n${note.trim()}` : note.trim();
    n.updatedAt = Date.now();
  }

  function addChapter(id: string, ch: Omit<NovelChapter, 'id' | 'at'>): NovelChapter | undefined {
    const n = novelById(id);
    if (!n) return undefined;
    const c: NovelChapter = { ...ch, id: uid('chap'), at: Date.now() };
    n.chapters.push(c);
    n.updatedAt = Date.now();
    return n.chapters.at(-1);
  }

  function updateChapter(id: string, chapterId: string, patch: Partial<Pick<NovelChapter, 'title' | 'text'>>) {
    const c = novelById(id)?.chapters.find((x) => x.id === chapterId);
    if (!c) return;
    Object.assign(c, patch, { at: Date.now() });
    const n = novelById(id);
    if (n) n.updatedAt = Date.now();
  }

  function removeChapter(id: string, chapterId: string) {
    const n = novelById(id);
    if (n) n.chapters = n.chapters.filter((c) => c.id !== chapterId);
  }

  function addDrawing(d: Omit<Drawing, 'id' | 'at'>): Drawing {
    drawings.value.unshift({ ...d, id: uid('draw'), at: Date.now() });
    return drawings.value[0]!;
  }

  function removeDrawing(id: string) {
    drawings.value = drawings.value.filter((d) => d.id !== id);
  }

  return { novels, drawings, hydrate, novelById, createNovel, updateNovel, removeNovel, addTalk, clearTalk, addNote, addChapter, updateChapter, removeChapter, addDrawing, removeDrawing };
});
