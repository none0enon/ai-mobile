import { reactive } from 'vue';
import type { SongInfo, SongList } from './types';

/**
 * 我们的歌单：一起喜欢的歌（一起听歌时点 ♡）、存下来的网易云歌单 / 专辑。
 * 一起听歌和哄睡的音乐共用这一份（哄睡里也能挑这些歌单放、把导入的歌单存进来）。只存在这台设备的浏览器里。
 */

export interface SavedList extends SongList {
  /** playlist:id 或 album:id */
  key: string;
  type: 'playlist' | 'album';
  savedAt: number;
}

const LIKED_KEY = 'ai-mobile:music:liked:v1';
const LISTS_KEY = 'ai-mobile:music:lists:v1';

function readList<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** 存不下（浏览器存储满了或者被禁用了）时返回 false */
function writeList(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const musicLibrary = reactive({
  liked: readList<SongInfo>(LIKED_KEY),
  lists: readList<SavedList>(LISTS_KEY),
});

export function isLiked(id: string): boolean {
  return musicLibrary.liked.some((s) => s.id === id);
}

/** 喜欢 / 取消喜欢这首；存不下时返回 false */
export function toggleLike(song: SongInfo): boolean {
  musicLibrary.liked = isLiked(song.id) ? musicLibrary.liked.filter((x) => x.id !== song.id) : [song, ...musicLibrary.liked].slice(0, 500);
  return writeList(LIKED_KEY, musicLibrary.liked);
}

/** 存进我们的歌单（同一个歌单再存是更新，排到最前）；存不下时返回 false */
export function saveList(list: Omit<SavedList, 'savedAt'>): boolean {
  musicLibrary.lists = [{ ...list, savedAt: Date.now() }, ...musicLibrary.lists.filter((x) => x.key !== list.key)].slice(0, 30);
  return writeList(LISTS_KEY, musicLibrary.lists);
}

export function removeList(key: string): boolean {
  musicLibrary.lists = musicLibrary.lists.filter((x) => x.key !== key);
  return writeList(LISTS_KEY, musicLibrary.lists);
}
