import { defineStore } from 'pinia';
import { ref } from 'vue';
import { parseAvatar, seededAvatar, type Avatar } from '@/components/scene/game/decor/avatar';
import { MAX_ROOMS, sanitizeRooms, starterRoom, starterRooms, STARTER_ROOM_TYPES, type DecorRoom } from '@/components/scene/game/decor/model';
import { autoSave, getOne } from '@/db/idb';

/**
 * 装修小屋的存档：每个角色一套小屋（一开始 6 个房间：主卧、次卧、客厅、厨房、洗手间、书房，最多 10 个），加上你和她的小人（设计文档 §9.11）。
 * 存在本机（settings 表的 decorHomes），只放能 JSON 化的数据。老存档只有一间屋子：读的时候把它当客厅，补上另外几间。
 */
export interface DecorHome {
  rooms: DecorRoom[];
  /** 现在看的是第几间 */
  current: number;
  you: Avatar;
  her: Avatar;
  /** 她给自己捏过了（没捏过时用按角色 id 定的初始样子） */
  herDesigned?: boolean;
  updatedAt: number;
}

const KEY = 'decorHomes';
/** 一开始看的那一间：客厅 */
const LIVING = STARTER_ROOM_TYPES.indexOf('living');

function clampIndex(v: unknown, rooms: readonly DecorRoom[], fallback: number): number {
  const n = typeof v === 'number' && Number.isInteger(v) ? v : fallback;
  return Math.min(rooms.length - 1, Math.max(0, n));
}

export const useDecorStore = defineStore('decor', () => {
  const homes = ref<Record<string, DecorHome>>({});
  const ready = ref(false);
  const saver = autoSave('settings', () => [{ key: KEY, value: homes.value }], homes);

  async function hydrate() {
    const saved = await getOne<Record<string, unknown>>('settings', KEY);
    const out: Record<string, DecorHome> = {};
    if (saved && typeof saved === 'object') {
      for (const [id, v] of Object.entries(saved)) {
        const o = v as (Partial<DecorHome> & { room?: unknown }) | null;
        const rooms = sanitizeRooms(o?.rooms, o?.room);
        if (!o || !rooms) continue;
        out[id] = {
          rooms,
          current: clampIndex(o.current, rooms, Array.isArray(o.rooms) ? 0 : LIVING),
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

  /** 这个角色的小屋（第一次来时给 6 个带几件家具的房间，先看客厅） */
  function homeOf(characterId: string): DecorHome {
    let h = homes.value[characterId];
    if (!h) {
      h = { rooms: starterRooms(), current: LIVING, you: parseAvatar(null), her: seededAvatar(characterId), updatedAt: Date.now() };
      homes.value = { ...homes.value, [characterId]: h };
    }
    return homes.value[characterId]!;
  }

  function patch(characterId: string, change: Partial<DecorHome>) {
    const h = homeOf(characterId);
    homes.value = { ...homes.value, [characterId]: { ...h, ...change, updatedAt: Date.now() } };
  }

  /** 改现在看的这一间（按房间的 id 认，免得换了房间之后改错） */
  function setRoom(characterId: string, room: DecorRoom) {
    const h = homeOf(characterId);
    if (!h.rooms.some((r) => r.id === room.id)) return;
    patch(characterId, { rooms: h.rooms.map((r) => (r.id === room.id ? room : r)) });
  }

  /** 去第几间 */
  function setCurrent(characterId: string, index: number) {
    const h = homeOf(characterId);
    patch(characterId, { current: clampIndex(index, h.rooms, h.current) });
  }

  /** 添一间（最多 MAX_ROOMS 间），添完就去那一间；满了返回 null */
  function addRoom(characterId: string, type: string): DecorRoom | null {
    const h = homeOf(characterId);
    if (h.rooms.length >= MAX_ROOMS) return null;
    const room = starterRoom(type, h.rooms);
    patch(characterId, { rooms: [...h.rooms, room], current: h.rooms.length });
    return room;
  }

  /** 拆掉一间（至少留一间） */
  function removeRoom(characterId: string, roomId: string): boolean {
    const h = homeOf(characterId);
    const i = h.rooms.findIndex((r) => r.id === roomId);
    if (i < 0 || h.rooms.length <= 1) return false;
    const rooms = h.rooms.filter((r) => r.id !== roomId);
    patch(characterId, { rooms, current: i < h.current ? h.current - 1 : Math.min(h.current, rooms.length - 1) });
    return true;
  }

  function setAvatar(characterId: string, who: 'you' | 'her', avatar: Avatar) {
    const h = homeOf(characterId);
    homes.value = { ...homes.value, [characterId]: { ...h, [who]: avatar, ...(who === 'her' ? { herDesigned: true } : {}), updatedAt: Date.now() } };
  }

  return { homes, ready, hydrate, homeOf, setRoom, setCurrent, addRoom, removeRoom, setAvatar };
});
