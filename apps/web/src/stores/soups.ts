import { defineStore } from 'pinia';
import { ref } from 'vue';
import { autoSave, getOne, write } from '@/db/idb';
import { uid } from '@/utils/id';

/** 一道海龟汤：汤面给你看，汤底和关键点只给主持人那次调用 */
export interface Soup {
  id: string;
  title: string;
  /** 汤面 */
  surface: string;
  /** 汤底 */
  truth: string;
  /** 要问出来的关键点 */
  keys: string[];
  difficulty: number;
  /**
   * 尺度：题库文件里写的（清汤、红汤……），不写当清汤。和海龟汤预设里的尺度（soup-level:名字）同名时按尺度筛：
   * 选了某个尺度，列出它和排在它前面的尺度的题；名字对不上任何尺度的题一直列出来
   */
  kind: string;
  style?: '本格' | '变格';
  /** 来自哪个题库文件（可以恢复成文件里的样子） */
  seedFile?: string;
  /** 现编的 / 你写的 */
  origin?: 'made' | 'mine';
}

/**
 * 海龟汤题库：src/soups/ 里的题库文件（App 自己的格式），和预设文件一样，
 * 第一次打开时放进题库，之后能改能删；删掉的不会再放回来；往文件夹里加一个文件就多一组题。
 * 现编的题、你自己写的题也放在这里。
 */
const FILES = import.meta.glob<unknown>('../soups/*.json', { eager: true, import: 'default' });

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 读一道题（题库文件里的、模型现编的都用它检查） */
export function parseSoup(raw: unknown): Omit<Soup, 'id'> & { id?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const surface = str(o.surface);
  const truth = str(o.truth);
  const keys = Array.isArray(o.keys) ? o.keys.map(str).filter(Boolean) : [];
  if (!surface || !truth || !keys.length) return null;
  return {
    ...(str(o.id) ? { id: str(o.id) } : {}),
    title: str(o.title) || surface.slice(0, 12),
    surface,
    truth,
    keys,
    difficulty: Math.min(3, Math.max(1, Number(o.difficulty) || 1)),
    kind: str(o.kind) || '清汤',
    ...(o.style === '本格' || o.style === '变格' ? { style: o.style } : {}),
  };
}

function readSeeds(): { file: string; soups: Soup[] }[] {
  const out: { file: string; soups: Soup[] }[] = [];
  for (const [path, json] of Object.entries(FILES)) {
    const file = path.split('/').pop() ?? path;
    const list = (json as { soups?: unknown[] })?.soups;
    if (!Array.isArray(list)) continue;
    const soups = list
      .map(parseSoup)
      .filter((s): s is NonNullable<ReturnType<typeof parseSoup>> => !!s)
      .map((s, i) => ({ ...s, id: s.id ?? `soup-${file.replace(/\.json$/i, '')}-${i}`, seedFile: file }));
    out.push({ file, soups });
  }
  return out;
}

const SEEDS = readSeeds();

export const useSoupStore = defineStore('soups', () => {
  const soups = ref<Soup[]>(SEEDS.flatMap((s) => s.soups));
  const saver = autoSave('settings', () => [{ key: 'soupLibrary', value: soups.value }], soups);

  async function hydrate() {
    const [saved, seeded] = await Promise.all([getOne<Soup[]>('settings', 'soupLibrary'), getOne<string[]>('settings', 'seededSoupFiles')]);
    const done = new Set(Array.isArray(seeded) ? seeded : []);
    const list: Soup[] = Array.isArray(saved) ? saved.filter((s) => s && typeof s.id === 'string') : [];
    // 新的题库文件（第一次打开，或者 App 更新后多了一个）：放进题库；放进来过、又被你删掉的不再放回来
    for (const s of SEEDS) {
      if (done.has(s.file)) continue;
      for (const soup of s.soups) if (!list.some((x) => x.id === soup.id)) list.push(soup);
      done.add(s.file);
    }
    soups.value = list;
    await write('settings', [
      { key: 'soupLibrary', value: JSON.parse(JSON.stringify(list)) },
      { key: 'seededSoupFiles', value: [...done] },
    ]);
    saver.start();
  }

  function add(soup: Omit<Soup, 'id'>): Soup {
    const s: Soup = { ...soup, id: uid('soup') };
    soups.value.push(s);
    return s;
  }

  function remove(id: string) {
    soups.value = soups.value.filter((s) => s.id !== id);
  }

  return { soups, hydrate, add, remove };
});
