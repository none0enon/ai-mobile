import { DEFAULT_HEALTH, normalizeHealth, normalizeHousework, type Chat, type HealthSettings, type HouseworkSettings, type Persona } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { personas as demoPersonas } from '@/mock/characters';
import { uid } from '@/utils/id';

/**
 * 我的人设（ST 的 Persona）：角色眼中的"你"。可以有多个身份，聊天里用默认的那个（聊天上另选的除外）。
 * 名字、描述、家务系统、健康系统都存在本机（settings 表的 personas 一项），改了刷新后还在。
 * 第一次打开时用演示的两个身份。
 */

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** 读进来的人设补齐字段（以前没有家务、健康两套系统） */
function normalize(p: Persona): Persona {
  const out: Persona = { ...p, name: p.name || '你', description: p.description ?? '', isDefault: !!p.isDefault };
  if (p.housework) out.housework = normalizeHousework(p.housework);
  if (p.health) out.health = normalizeHealth(p.health);
  return out;
}

export const usePersonaStore = defineStore('personas', () => {
  const list = ref<Persona[]>(clone(demoPersonas));
  const saver = autoSave('settings', () => [{ key: 'personas', value: list.value }], list);

  async function hydrate() {
    const saved = await getOne<Persona[]>('settings', 'personas');
    if (Array.isArray(saved) && saved.length) list.value = saved.filter((p) => p && typeof p.id === 'string').map(normalize);
    if (!list.value.some((p) => p.isDefault) && list.value[0]) list.value[0].isDefault = true;
    saver.start();
  }

  /** 默认身份（一个都没有时用演示的第一个，不会是空的） */
  const defaultPersona = computed<Persona>(() => list.value.find((p) => p.isDefault) ?? list.value[0] ?? (clone(demoPersonas[0]) as Persona));

  function byId(id: string | null | undefined): Persona | undefined {
    return list.value.find((p) => p.id === id);
  }

  /** 这条聊天用的身份：聊天上选了就用它，否则默认的 */
  function forChat(chat: Pick<Chat, 'personaId'> | null | undefined): Persona {
    return byId(chat?.personaId) ?? defaultPersona.value;
  }

  function touch(p: Persona) {
    p.updatedAt = Date.now();
  }

  function setDefault(id: string) {
    for (const p of list.value) p.isDefault = p.id === id;
  }

  function add(): Persona {
    const now = Date.now();
    list.value.push({ id: uid('persona'), createdAt: now, updatedAt: now, name: '新身份', avatar: null, description: '', isDefault: !list.value.length });
    return list.value.at(-1) as Persona;
  }

  /** 删掉一个身份（至少留一个）；删的是默认的就把第一个设成默认 */
  function remove(id: string): boolean {
    if (list.value.length <= 1) return false;
    const was = byId(id)?.isDefault;
    list.value = list.value.filter((p) => p.id !== id);
    if (was && list.value[0]) list.value[0].isDefault = true;
    return true;
  }

  /** 家务系统的设置（还没有时建一份关着的） */
  function housework(p: Persona): HouseworkSettings {
    if (!p.housework) p.housework = { enabled: false, chores: [] };
    return p.housework;
  }

  /** 健康系统的设置（还没有时按默认值建一份关着的） */
  function health(p: Persona): HealthSettings {
    if (!p.health) p.health = clone(DEFAULT_HEALTH);
    return p.health;
  }

  return { list, hydrate, defaultPersona, byId, forChat, touch, setDefault, add, remove, housework, health };
});
