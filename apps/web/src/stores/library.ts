import type { Lorebook, Preset } from '@app/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { autoSave, getAll } from '@/db/idb';
import { lorebooks as demoLorebooks, presets as demoPresets } from '@/mock/library';

/** 演示用的预设、世界书：每次打开重新生成，不存进本机数据库 */
const DEMO_IDS = new Set([...demoPresets.map((p) => p.id), ...demoLorebooks.map((b) => b.id)]);

export function isDemoRecord(id: string) {
  return DEMO_IDS.has(id);
}

/** 预设和世界书。导入的存在本机（IndexedDB） */
export const useLibraryStore = defineStore('library', () => {
  const presets = ref<Preset[]>([...demoPresets]);
  const lorebooks = ref<Lorebook[]>([...demoLorebooks]);

  const presetSaver = autoSave(
    'presets',
    () => presets.value.filter((p) => !DEMO_IDS.has(p.id)).map((p) => ({ key: p.id, value: p })),
    presets,
  );
  const bookSaver = autoSave(
    'lorebooks',
    () => lorebooks.value.filter((b) => !DEMO_IDS.has(b.id)).map((b) => ({ key: b.id, value: b })),
    lorebooks,
  );

  async function hydrate() {
    const [ps, bs] = await Promise.all([getAll<Preset>('presets'), getAll<Lorebook>('lorebooks')]);
    // 库里按 id 排，id 是随机的：按导入时间排回来
    const byTime = <T extends { createdAt: number }>(a: T, b: T) => a.createdAt - b.createdAt;
    for (const p of ps.sort(byTime)) if (!presets.value.some((x) => x.id === p.id)) presets.value.push(p);
    for (const b of bs.sort(byTime)) if (!lorebooks.value.some((x) => x.id === b.id)) lorebooks.value.push(b);
    presetSaver.start();
    bookSaver.start();
  }

  function presetById(id: string | null | undefined): Preset | undefined {
    return presets.value.find((p) => p.id === id);
  }

  function lorebookById(id: string | null | undefined): Lorebook | undefined {
    return lorebooks.value.find((b) => b.id === id);
  }

  function addPreset(p: Preset) {
    presets.value.push(p);
    return presets.value.at(-1) as Preset;
  }

  function addLorebook(b: Lorebook) {
    lorebooks.value.push(b);
    return lorebooks.value.at(-1) as Lorebook;
  }

  function removePreset(id: string) {
    presets.value = presets.value.filter((p) => p.id !== id);
  }

  function removeLorebook(id: string) {
    lorebooks.value = lorebooks.value.filter((b) => b.id !== id);
  }

  return { presets, lorebooks, hydrate, presetById, lorebookById, addPreset, addLorebook, removePreset, removeLorebook };
});
