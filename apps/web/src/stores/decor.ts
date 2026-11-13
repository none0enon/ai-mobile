import { defineStore } from 'pinia';
import { ref } from 'vue';
import { parseAvatar, seededAvatar, type Avatar } from '@/components/scene/game/decor/avatar';
import { sanitizeRoom, starterRoom, type DecorRoom } from '@/components/scene/game/decor/model';
import { autoSave, getOne } from '@/db/idb';

/**
 * 装修小屋的存档：每个角色一间屋子，加上你和她的小人（设计文档 §9.11）。
 * 存在本机（settings 表的 decorHomes），只放能 JSON 化的数据。
 */
export interface DecorHome {
  room: DecorRoom;
  you: Avatar;
  her: Avatar;
  /** 她给自己捏过了（没捏过时用按角色 id 定的初始样子） */
  herDesigned?: boolean;
  updatedAt: number;
}

const KEY = 'decorHomes';

export const useDecorStore = defineStore('decor', () => {
  const homes = ref<Record<string, DecorHome>>({});
  const ready = ref(false);
  const saver = autoSave('settings', () => [{ key: KEY, value: homes.value }], homes);

  async function hydrate() {
    const saved = await getOne<Record<string, unknown>>('settings', KEY);
    const out: Record<string, DecorHome> = {};
    if (saved && typeof saved === 'object') {
      for (const [id, v] of Object.entries(saved)) {
        const o = v as Partial<DecorHome> | null;
        const room = sanitizeRoom(o?.room);
        if (!o || !room) continue;
        out[id] = {
          room,
          you: parseAvatar(o.you),
          her: parseAvatar(o.her, seededAvatar(id)),
          ...(o.herDesigned ? { herDesigned: true } : {}),
          updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
        };
      }
    }
    homes.value = out;
    ready.value = true;
    saver.start();
  }

  /** 这个角色的小屋（第一次来时给一间带几件家具的） */
  function homeOf(characterId: string): DecorHome {
    let h = homes.value[characterId];
    if (!h) {
      h = { room: starterRoom(), you: parseAvatar(null), her: seededAvatar(characterId), updatedAt: Date.now() };
      homes.value = { ...homes.value, [characterId]: h };
    }
    return homes.value[characterId]!;
  }

  function setRoom(characterId: string, room: DecorRoom) {
    const h = homeOf(characterId);
    homes.value = { ...homes.value, [characterId]: { ...h, room, updatedAt: Date.now() } };
  }

  function setAvatar(characterId: string, who: 'you' | 'her', avatar: Avatar) {
    const h = homeOf(characterId);
    homes.value = { ...homes.value, [characterId]: { ...h, [who]: avatar, ...(who === 'her' ? { herDesigned: true } : {}), updatedAt: Date.now() } };
  }

  return { homes, ready, hydrate, homeOf, setRoom, setAvatar };
});
