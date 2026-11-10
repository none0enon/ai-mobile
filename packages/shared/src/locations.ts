import type { SceneId } from './scenes.ts';

/**
 * 小地图上的地点。场景不再是一个个独立入口，而是"地点 + 在那里能做的事"：
 * 图书馆 → 陪伴学习，家里的卧室 → 哄睡，水族馆 → 约会……
 * 角色此刻在哪由她的模拟作息决定（Character.locationId），你点地点就是"和她一起去"。
 */
export type LocationArea = 'home' | 'campus' | 'city';

export interface LocationActivity {
  sceneId: SceneId;
  label: string;
  /** 约会地点：对应约会场景里的地点 id */
  datePlace?: string;
}

export interface MapLocation {
  id: string;
  name: string;
  area: LocationArea;
  icon: string;
  /** 在地图上的位置，0-100（相对地图宽高） */
  x: number;
  y: number;
  /** 场景背景 key */
  backdrop: string;
  indoor: boolean;
  blurb: string;
  activities: LocationActivity[];
}

export const AREA_LABEL: Record<LocationArea, string> = { home: '家', campus: '学校', city: '城里' };

export const LOCATIONS: MapLocation[] = [
  {
    id: 'home',
    name: '家',
    area: 'home',
    icon: 'i-lucide-house',
    x: 15,
    y: 24,
    backdrop: 'bedroom',
    indoor: true,
    blurb: '卧室、餐桌、客厅',
    activities: [
      { sceneId: 'sleep', label: '卧室 · 哄睡' },
      { sceneId: 'meal', label: '餐桌 · 一起吃饭' },
      { sceneId: 'music', label: '客厅 · 一起听歌' },
      { sceneId: 'poke', label: '沙发 · 戳戳乐' },
    ],
  },
  {
    id: 'library',
    name: '图书馆',
    area: 'campus',
    icon: 'i-lucide-library-big',
    x: 58,
    y: 15,
    backdrop: 'library',
    indoor: true,
    blurb: '三楼靠窗的位置',
    activities: [{ sceneId: 'study', label: '陪伴学习' }],
  },
  {
    id: 'canteen',
    name: '食堂',
    area: 'campus',
    icon: 'i-lucide-utensils',
    x: 82,
    y: 16,
    backdrop: 'dining',
    indoor: true,
    blurb: '二楼的麻辣烫最好吃',
    activities: [{ sceneId: 'meal', label: '一起吃饭' }],
  },
  {
    id: 'track',
    name: '操场',
    area: 'campus',
    icon: 'i-lucide-footprints',
    x: 64,
    y: 38,
    backdrop: 'park',
    indoor: false,
    blurb: '400 米跑道，晚上有灯',
    activities: [{ sceneId: 'exercise', label: '一起跑步' }],
  },
  {
    id: 'gym',
    name: '游泳馆',
    area: 'campus',
    icon: 'i-lucide-waves',
    x: 87,
    y: 40,
    backdrop: 'park',
    indoor: true,
    blurb: '游泳队训练的地方',
    activities: [{ sceneId: 'exercise', label: '一起运动' }],
  },
  {
    id: 'cafe',
    name: '咖啡店',
    area: 'city',
    icon: 'i-lucide-coffee',
    x: 33,
    y: 50,
    backdrop: 'cafe',
    indoor: true,
    blurb: '靠窗的位置，下雨也不怕',
    activities: [
      { sceneId: 'date', label: '约会', datePlace: 'cafe' },
      { sceneId: 'study', label: '一起自习' },
    ],
  },
  {
    id: 'gallery',
    name: '美术馆',
    area: 'city',
    icon: 'i-lucide-frame',
    x: 13,
    y: 58,
    backdrop: 'gallery',
    indoor: true,
    blurb: '安静地看展',
    activities: [{ sceneId: 'date', label: '约会', datePlace: 'gallery' }],
  },
  {
    id: 'cinema',
    name: '电影院',
    area: 'city',
    icon: 'i-lucide-clapperboard',
    x: 52,
    y: 60,
    backdrop: 'cinema',
    indoor: true,
    blurb: '一桶爆米花两个人',
    activities: [{ sceneId: 'date', label: '约会', datePlace: 'cinema' }],
  },
  {
    id: 'night-market',
    name: '夜市',
    area: 'city',
    icon: 'i-lucide-lamp',
    x: 34,
    y: 78,
    backdrop: 'night-market',
    indoor: false,
    blurb: '一路吃过去',
    activities: [
      { sceneId: 'date', label: '约会', datePlace: 'night-market' },
      { sceneId: 'meal', label: '一起吃夜宵' },
    ],
  },
  {
    id: 'amusement',
    name: '游乐园',
    area: 'city',
    icon: 'i-lucide-ferris-wheel',
    x: 66,
    y: 77,
    backdrop: 'amusement',
    indoor: false,
    blurb: '摩天轮最高点',
    activities: [{ sceneId: 'date', label: '约会', datePlace: 'amusement' }],
  },
  {
    id: 'aquarium',
    name: '水族馆',
    area: 'city',
    icon: 'i-lucide-fish',
    x: 86,
    y: 66,
    backdrop: 'aquarium',
    indoor: true,
    blurb: '蓝色隧道里牵手',
    activities: [{ sceneId: 'date', label: '约会', datePlace: 'aquarium' }],
  },
  {
    id: 'riverside',
    name: '江边步道',
    area: 'city',
    icon: 'i-lucide-trees',
    x: 10,
    y: 88,
    backdrop: 'park',
    indoor: false,
    blurb: '散步、看江景',
    activities: [
      { sceneId: 'exercise', label: '散步 / 跑步' },
      { sceneId: 'date', label: '约会', datePlace: 'park' },
    ],
  },
  {
    id: 'seaside',
    name: '海边',
    area: 'city',
    icon: 'i-lucide-sailboat',
    x: 90,
    y: 90,
    backdrop: 'seaside',
    indoor: false,
    blurb: '看日落，捡贝壳',
    activities: [{ sceneId: 'date', label: '约会', datePlace: 'seaside' }],
  },
];

export function getLocation(id: string | null | undefined): MapLocation | undefined {
  return LOCATIONS.find((l) => l.id === id);
}

/** 某个场景默认去哪（从聊天的 ＋ 面板直接进场景时用） */
export function defaultLocationFor(sceneId: SceneId): MapLocation {
  const prefer: Partial<Record<SceneId, string>> = { study: 'library', exercise: 'track', meal: 'home', sleep: 'home', music: 'home', poke: 'home', date: 'aquarium' };
  return getLocation(prefer[sceneId]) ?? (LOCATIONS[0] as MapLocation);
}
