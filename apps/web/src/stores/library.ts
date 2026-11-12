import {
  parsePresetFile,
  presetUse,
  PRESET_USES,
  toPresetFile,
  type Character,
  type Lorebook,
  type Preset,
  type PresetCategory,
  type PresetFile,
  type PresetUse,
  type PresetUseId,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getAll, getOne, write } from '@/db/idb';
import { lorebooks as demoLorebooks } from '@/mock/library';
import { uid } from '@/utils/id';

/**
 * App 自带的预设：src/presets/ 里的预设文件（App 自己的格式）。往这个文件夹里加一个 .json 就多一个自带预设。
 * 第一次打开时像导入一样放进预设库，之后和你导入的一样：能改、能删、能复制、能导出；删掉的不会再放回来。
 */
const FILES = import.meta.glob<unknown>('../presets/*.json', { eager: true, import: 'default' });

interface Seed {
  file: string;
  preset: Preset;
  defaultFor: PresetUseId[];
}

function readSeeds(): Seed[] {
  const out: Seed[] = [];
  for (const [path, json] of Object.entries(FILES)) {
    const file = path.split('/').pop() ?? path;
    try {
      const { warnings: _w, defaultFor, id, ...data } = parsePresetFile(json, file);
      const now = Date.now();
      out.push({ file, defaultFor, preset: { ...data, id: id ?? `preset-${file.replace(/\.json$/i, '')}`, createdAt: now, updatedAt: now, seedFile: file } });
    } catch (e) {
      console.error(`预设文件 ${file} 读不出来：`, e);
    }
  }
  // 先对话、再功能……同一类按文件名
  const order: PresetCategory[] = ['chat', 'feature', 'proactive', 'theater', 'summary', 'image', 'rhythm'];
  return out.sort((a, b) => order.indexOf(a.preset.category) - order.indexOf(b.preset.category) || a.file.localeCompare(b.file));
}

const SEEDS = readSeeds();
const DEMO_BOOK_IDS = new Set(demoLorebooks.map((b) => b.id));

/**
 * 自带的预设文件改过以后，本机已经放进库里的那份怎么跟上。只动你没改过的地方，每一条只做一次：
 * - replaced：块的旧默认内容。本机那块还是旧的（你没改过）就换成文件里现在的；
 * - added：文件里新加的块。本机那份没有就照文件里的位置插进去（之后你删了不会再放回来）。
 * 复制出来的、导入的预设不动；想整份回到文件的样子用"恢复成预设文件"。
 */
interface SeedUpgrade {
  id: string;
  file: string;
  replaced?: Record<string, string[]>;
  added?: string[];
}
const SEED_UPGRADES: SeedUpgrade[] = [
  {
    // 一起看书能读带公式的专业书：识图读成 Markdown + LaTeX；新增"专业书"一块
    id: 'feature-read:math',
    file: 'feature-read.json',
    replaced: { readOcr: ['把图片里这一页书的正文原样读出来：一段一行，保留标点；不要页眉、页脚、页码和图片说明，不要加任何别的话。'] },
    added: ['readTechnical'],
  },
  {
    // 哄睡接上真实的模型和语音：低语、睡前故事、定时到了各一块，加上程序填这一次输入的"场景任务"
    id: 'feature-sleep:voice',
    file: 'feature-sleep.json',
    added: ['sleepWhisper', 'sleepStory', 'sleepEnd', 'sceneTask'],
  },
  {
    // 一起观影可以贴链接看（B 站 / YouTube / 视频直链）：没有逐句字幕时她怎么说
    id: 'feature-watch:link',
    file: 'feature-watch.json',
    added: ['watchLink'],
  },
  {
    // 看链接时像发弹幕一样吐槽；认得出片名里的作品、角色时可以就着说
    id: 'feature-watch:link-roast',
    file: 'feature-watch.json',
    replaced: {
      watchLink: [
        '这一次你们看的是一个视频链接，没有逐句字幕：场景任务里有平台、标题、作者、{{user}}贴的简介或内容、现在播到哪、你们刚才说过的话。你看不到画面也听不到声音，只知道这些。像坐在旁边一起看那样随口说一句（20 字以内）：可以接{{user}}刚才的话、聊标题和气氛、对进度有感而发，或者问一句；不要编造这些信息里没有的剧情、台词和画面细节；不要重复你刚才说过的话。',
      ],
    },
  },
];

/** 按 SEED_UPGRADES 更新本机的自带预设，返回改了的那些 */
function upgradeSeeded(list: Preset[], done: Set<string>): Preset[] {
  const changed = new Set<Preset>();
  for (const u of SEED_UPGRADES) {
    if (done.has(u.id)) continue;
    done.add(u.id);
    const seed = SEEDS.find((s) => s.file === u.file)?.preset;
    if (!seed) continue;
    for (const p of list) {
      if (p.seedFile !== u.file) continue;
      for (const [id, olds] of Object.entries(u.replaced ?? {})) {
        const mine = p.blocks.find((b) => b.identifier === id);
        const now = seed.blocks.find((b) => b.identifier === id);
        if (mine && now && mine.content !== now.content && olds.includes(mine.content.trim())) {
          mine.content = now.content;
          changed.add(p);
        }
      }
      for (const id of u.added ?? []) {
        const at = seed.blocks.findIndex((b) => b.identifier === id);
        if (at < 0 || p.blocks.some((b) => b.identifier === id)) continue;
        // 插在文件里它前面那一块的后面；那一块你删了就放最后
        const prev = seed.blocks[at - 1]?.identifier;
        const i = prev ? p.blocks.findIndex((b) => b.identifier === prev) : -1;
        p.blocks.splice(i >= 0 ? i + 1 : p.blocks.length, 0, clone(seed.blocks[at]!));
        changed.add(p);
      }
    }
  }
  for (const p of changed) p.updatedAt = Date.now();
  return [...changed];
}

/** 演示用的世界书（每次打开重新生成）；预设没有"自带的不能动"这回事 */
export function isDemoRecord(id: string) {
  return DEMO_BOOK_IDS.has(id);
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/**
 * 预设和世界书。
 * - 预设分七类（对话、功能、主动消息、小剧场、总结、生图、节律）；
 * - 每个用途（一起做事的每件事、主动消息、番外、总结、配图、一起做事时画的图、节律）选一个对应分类的预设；对话预设每个角色自己选；
 * - 所有预设都存在本机（自带的放进来以后也一样）。
 */
export const useLibraryStore = defineStore('library', () => {
  // 读本机数据库之前先用预设文件里的（启动时界面要有东西），读完以后以本机的为准
  const presets = ref<Preset[]>(SEEDS.map((s) => clone(s.preset)));
  const lorebooks = ref<Lorebook[]>([...demoLorebooks]);
  /** 每个用途选的预设；null = 跟随（对话预设，或者一起做事时画的图跟随配图） */
  const uses = reactive<Partial<Record<PresetUseId, string | null>>>(defaultUses(SEEDS));

  const presetSaver = autoSave('presets', () => presets.value.map((p) => ({ key: p.id, value: p })), presets);
  const bookSaver = autoSave(
    'lorebooks',
    () => lorebooks.value.filter((b) => !DEMO_BOOK_IDS.has(b.id)).map((b) => ({ key: b.id, value: b })),
    lorebooks,
  );
  const useSaver = autoSave('settings', () => [{ key: 'presetUses', value: { ...uses } }], () => ({ ...uses }));

  /** 预设文件里写的"默认给哪些用途用" */
  function defaultUses(seeds: Seed[]): Partial<Record<PresetUseId, string>> {
    const out: Partial<Record<PresetUseId, string>> = {};
    for (const s of seeds) for (const u of s.defaultFor) out[u] ??= s.preset.id;
    return out;
  }

  async function hydrate() {
    const [ps, bs, savedUses, seeded, upgraded] = await Promise.all([
      getAll<Preset>('presets'),
      getAll<Lorebook>('lorebooks'),
      getOne<Record<string, unknown>>('settings', 'presetUses'),
      getOne<string[]>('settings', 'seededPresetFiles'),
      getOne<string[]>('settings', 'presetUpgrades'),
    ]);
    const done = new Set(Array.isArray(seeded) ? seeded : []);
    const upgradesDone = new Set(Array.isArray(upgraded) ? upgraded : []);
    const saved = new Map(ps.map((p) => [p.id, { ...p, category: p.category ?? 'chat' } as Preset]));
    const list: Preset[] = [];
    const fresh: Seed[] = [];
    for (const s of SEEDS) {
      const mine = saved.get(s.preset.id);
      if (mine) {
        list.push(mine);
        saved.delete(s.preset.id);
      } else if (!done.has(s.file)) {
        // 新的预设文件（第一次打开，或者 App 更新后多了一个）：放进预设库
        list.push(clone(s.preset));
        fresh.push(s);
      }
      // 放进来过、本机又没有：你删掉了，不再放回来
    }
    // 导入的、复制的：按导入时间排（以前存的没有分类，都是对话预设）
    list.push(...[...saved.values()].sort((a, b) => a.createdAt - b.createdAt));
    // 自带预设文件后来改过的地方：本机那份你没改过就跟上
    const touched = upgradeSeeded(list, upgradesDone).filter((p) => !fresh.some((s) => s.preset.id === p.id));
    presets.value = list;

    for (const k of Object.keys(uses) as PresetUseId[]) delete uses[k];
    if (savedUses && typeof savedUses === 'object') {
      for (const u of PRESET_USES) {
        const v = savedUses[u.id];
        if (v === null && u.follow) uses[u.id] = null;
        else if (typeof v === 'string') uses[u.id] = v;
      }
    }
    // 预设文件写了默认给哪些用途：那个用途你还没选过、而且那个预设还在，就用它。
    // 以前只在第一次放进来时用一次、又没存下来，第二次打开就全变成"这一类的第一个"（场景都用成了约会的预设）
    for (const [u, id] of Object.entries(defaultUses(SEEDS)) as [PresetUseId, string][]) {
      if (!(u in uses) && list.some((p) => p.id === id)) uses[u] = id;
    }

    for (const s of SEEDS) done.add(s.file);
    await write('settings', [
      { key: 'seededPresetFiles', value: [...done] },
      { key: 'presetUpgrades', value: [...upgradesDone] },
      { key: 'presetUses', value: { ...uses } },
    ]);
    for (const b of bs.sort((a, b) => a.createdAt - b.createdAt)) if (!lorebooks.value.some((x) => x.id === b.id)) lorebooks.value.push(b);
    presetSaver.start();
    bookSaver.start();
    useSaver.start();
    // 新放进来的预设要写进本机（start 只记下现在的样子，不会自己写）
    if (fresh.length) await write('presets', fresh.map((s) => ({ key: s.preset.id, value: clone(presets.value.find((p) => p.id === s.preset.id)) })));
    if (touched.length) await write('presets', touched.map((p) => ({ key: p.id, value: clone(p) })));
  }

  function presetById(id: string | null | undefined): Preset | undefined {
    return presets.value.find((p) => p.id === id);
  }

  function presetsOf(category: PresetCategory): Preset[] {
    return presets.value.filter((p) => p.category === category);
  }

  /** 这个角色的对话预设；没选、选的被删了或不是对话预设时用第一个对话预设（一个都没有时为空） */
  function chatPresetFor(character?: Pick<Character, 'presetId'> | null): Preset | undefined {
    const own = presetById(character?.presetId);
    if (own?.category === 'chat') return own;
    return presetsOf('chat')[0];
  }

  /**
   * 这个用途选的预设 id；null = 跟随（对话预设 / 配图）；选的被删了时用这一类的第一个。
   * 一起做事时画的图没选过就跟随配图（自带了这个场景的生图预设的，预设文件里写了默认给它用）
   */
  function useChoice(use: PresetUseId): string | null | undefined {
    const meta = presetUse(use);
    const v = uses[use];
    if (meta?.follow && (v === null || (v === undefined && meta.follow === 'image'))) return null;
    const picked = presetById(v ?? undefined);
    if (picked && picked.category === meta?.category) return picked.id;
    if (meta?.follow === 'image') return null;
    return meta ? presetsOf(meta.category)[0]?.id : undefined;
  }

  /**
   * 这个用途这次用哪个预设。跟随时用对话预设 / 配图的预设；
   * 这一类一个都没有时：能跟随对话的用对话预设，其余为空（调用方说清楚缺什么）
   */
  function presetForUse(use: PresetUseId, character?: Pick<Character, 'presetId'> | null): Preset | undefined {
    const meta = presetUse(use);
    const choice = useChoice(use);
    if (choice === null) return meta?.follow === 'image' ? presetForUse('image', character) : chatPresetFor(character);
    const p = presetById(choice);
    if (p) return p;
    return meta?.follow === 'chat' ? chatPresetFor(character) : undefined;
  }

  function setUse(use: PresetUseId, id: string | null) {
    uses[use] = id;
  }

  /** 用着这个预设的用途 */
  function usesOf(presetId: string): PresetUse[] {
    return PRESET_USES.filter((u) => useChoice(u.id) === presetId);
  }

  function lorebookById(id: string | null | undefined): Lorebook | undefined {
    return lorebooks.value.find((b) => b.id === id);
  }

  function addPreset(p: Preset) {
    presets.value.push(p);
    return presets.value.at(-1) as Preset;
  }

  /** 复制一份；角色扮演类的可以复制成另一类（例如把导入的对话预设复制成功能预设） */
  function duplicatePreset(id: string, category?: PresetCategory): Preset | undefined {
    const src = presetById(id);
    if (!src) return undefined;
    const now = Date.now();
    const { seedFile: _f, ...rest } = clone(src);
    return addPreset({ ...rest, id: uid('preset'), createdAt: now, updatedAt: now, name: `${src.name}（副本）`, category: category ?? src.category });
  }

  /** 从 App 自带的预设文件放进来的：文件里现在的样子（可以恢复成它） */
  function seedOf(id: string): Preset | undefined {
    const p = presetById(id);
    const s = SEEDS.find((x) => x.file === p?.seedFile);
    return s ? clone(s.preset) : undefined;
  }

  /** 恢复成预设文件里的样子（名字、分类、块、参数都按文件） */
  function restoreFromFile(id: string): boolean {
    const i = presets.value.findIndex((p) => p.id === id);
    const s = seedOf(id);
    if (i < 0 || !s) return false;
    presets.value[i] = { ...s, id, createdAt: presets.value[i]!.createdAt, updatedAt: Date.now() };
    return true;
  }

  /** 导出成预设文件（App 自己的格式，带上它现在给哪些用途用） */
  function exportFile(id: string): PresetFile | undefined {
    const p = presetById(id);
    return p ? toPresetFile(p, usesOf(id).map((u) => u.id)) : undefined;
  }

  function addLorebook(b: Lorebook) {
    lorebooks.value.push(b);
    return lorebooks.value.at(-1) as Lorebook;
  }

  /** 删掉一个预设（自带的也能删）；选了它的用途改用这一类的第一个 */
  function removePreset(id: string) {
    presets.value = presets.value.filter((p) => p.id !== id);
    for (const u of PRESET_USES) if (uses[u.id] === id) delete uses[u.id];
  }

  function removeLorebook(id: string) {
    lorebooks.value = lorebooks.value.filter((b) => b.id !== id);
  }

  return {
    presets,
    lorebooks,
    uses,
    hydrate,
    presetById,
    presetsOf,
    chatPresetFor,
    useChoice,
    presetForUse,
    setUse,
    usesOf,
    lorebookById,
    addPreset,
    duplicatePreset,
    seedOf,
    restoreFromFile,
    exportFile,
    addLorebook,
    removePreset,
    removeLorebook,
  };
});
