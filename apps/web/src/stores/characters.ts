import { normalizeExpression, slotAt, worldOf, type Character } from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getAll, write } from '@/db/idb';
import { dropAsset } from '@/services/assets';
import { characters } from '@/mock/characters';

/** 她们此刻在各自世界的哪儿：按作息表（和你同一个时间）。M3 起由 Worker 的 Cron 推进并同步 */
for (const c of characters) {
  const slot = slotAt(worldOf(c.id), new Date());
  if (slot) Object.assign(c, { locationId: slot.locationId, status: slot.status });
}

/** 所有角色的设置都存在本机，云端主动消息不会因重开 App 被重置 */
const DEMO_IDS = new Set(characters.map((c) => c.id));

export const useCharacterStore = defineStore('characters', () => {
  const list = ref<Character[]>([...characters]);
  /** 每个角色此刻的立绘表情（由流式回复里的 [expr:] 标签、戳戳乐驱动） */
  const expression = reactive<Record<string, string>>({ suwan: 'smile', jiangyu: 'neutral' });
  /** 换了几次表情：同一个表情有好几张立绘时按它轮着用 */
  const expressionSeq = reactive<Record<string, number>>({});
  /** 模型用 [pose:] 换的立绘动作（立绘的动作 id）；场景要求的姿势优先 */
  const pose = reactive<Record<string, string>>({});

  const saver = autoSave(
    'characters',
    () => list.value.map((c) => ({ key: c.id, value: c })),
    list,
  );

  async function hydrate() {
    const saved = (await getAll<Character>('characters')).sort((a, b) => a.createdAt - b.createdAt);
    for (const c of saved) {
      const existing = list.value.findIndex((x) => x.id === c.id);
      if (existing >= 0) list.value[existing] = c;
      else list.value.push(c);
    }
    await write('characters', list.value.map((c) => ({ key: c.id, value: JSON.parse(JSON.stringify(c)) })));
    saver.start();
  }

  function byId(id: string | null | undefined): Character | undefined {
    return list.value.find((c) => c.id === id);
  }

  function isDemo(id: string) {
    return DEMO_IDS.has(id);
  }

  function add(c: Character) {
    list.value.push(c);
    return list.value.at(-1) as Character;
  }

  function remove(id: string) {
    const model = byId(id)?.live2d?.assetId;
    const images = byId(id)?.portraits?.portraits.map((p) => p.assetKey) ?? [];
    list.value = list.value.filter((c) => c.id !== id);
    if (model && !list.value.some(c => c.live2d?.assetId === model)) void write('live2d', [], [model]);
    // 立绘的图：别的角色没在用的从本机素材库删掉
    const used = new Set(list.value.flatMap((c) => c.portraits?.portraits.map((p) => p.assetKey) ?? []));
    for (const key of new Set(images)) if (!used.has(key)) void dropAsset(key);
  }

  /** 换预设：下一条回复起按新预设拼提示词，聊天记录不动 */
  function setPreset(id: string, presetId: string) {
    const c = byId(id);
    if (c) Object.assign(c, { presetId, updatedAt: Date.now() });
  }

  /** 换表情：她自己的表情（名字或 id）直接用；程序说的情绪（smile、shy……）按名字对到她的表情上；对不上的不换 */
  function setExpression(id: string, value: string) {
    const v = normalizeExpression(value, byId(id)?.portraits);
    if (!v) return;
    expression[id] = v;
    expressionSeq[id] = (expressionSeq[id] ?? 0) + 1;
  }

  /** 换立绘动作（id 或名字）；这个角色没有这个动作时不换 */
  function setPose(id: string, value: string) {
    const v = value.trim();
    const p = byId(id)?.portraits?.poses.find((x) => x.id === v || x.label === v);
    if (p) pose[id] = p.id;
  }

  function bumpAffection(id: string, delta: number) {
    const c = byId(id);
    if (c) c.relationship.affection = Math.max(0, Math.min(100, c.relationship.affection + delta));
  }

  return { list, expression, expressionSeq, pose, hydrate, byId, isDemo, add, remove, setPreset, setExpression, setPose, bumpAffection };
});
