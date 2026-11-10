import { slotAt, worldOf, type Character } from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { characters } from '@/mock/characters';

/** 她们此刻在各自世界的哪儿：按作息表（和你同一个时间）。M3 起由 Worker 的 Cron 推进并同步 */
for (const c of characters) {
  const slot = slotAt(worldOf(c.id), new Date());
  if (slot) Object.assign(c, { locationId: slot.locationId, status: slot.status });
}

export const useCharacterStore = defineStore('characters', () => {
  const list = ref<Character[]>(characters);
  /** 每个角色此刻的立绘表情（由流式回复里的 [expr:] 标签、戳戳乐驱动） */
  const expression = reactive<Record<string, string>>({ suwan: 'smile', jiangyu: 'neutral' });

  function byId(id: string | null | undefined): Character | undefined {
    return list.value.find((c) => c.id === id);
  }

  function setExpression(id: string, value: string) {
    expression[id] = value;
  }

  function bumpAffection(id: string, delta: number) {
    const c = byId(id);
    if (c) c.relationship.affection = Math.max(0, Math.min(100, c.relationship.affection + delta));
  }

  return { list, expression, byId, setExpression, bumpAffection };
});
