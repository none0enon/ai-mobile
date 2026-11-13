import type { MapLocation } from '@app/shared';

/**
 * 你的真实世界（演示数据）。正式版：家的坐标来自 Google 地理编码，附近地点来自 Google Places 附近搜索。
 * 这里的店名都是泛称，不对应真实商家。
 * 家的地址不写进代码仓库：默认取构建时的 VITE_HOME_ADDRESS（只用于私人预览），之后在"环境与作息"里改，存本机。
 */
export const DEMO_HOME_ADDRESS: string = (import.meta.env.VITE_HOME_ADDRESS as string | undefined) ?? '';

export const REAL_HOME_ID = 'real:home';
/** 你出门了、又不在附近哪个认得的地方时，"你在哪"就是它（不记进足迹） */
export const REAL_OUT_ID = 'real:out';

export function realHome(address: string, at?: { lat: number; lng: number } | null): MapLocation {
  return {
    id: REAL_HOME_ID,
    name: '家',
    area: 'real',
    icon: 'i-lucide-house',
    x: 50,
    y: 52,
    backdrop: 'bedroom',
    indoor: true,
    blurb: address || '还没设置家的地址',
    address,
    distanceKm: 0,
    ...(at ? { lat: at.lat, lng: at.lng } : {}),
    activities: [
      { sceneId: 'home', label: '共同的家' },
      { sceneId: 'sleep', label: '哄睡' },
      { sceneId: 'meal', label: '在家吃饭' },
      { sceneId: 'music', label: '一起听歌' },
      { sceneId: 'poke', label: '戳戳乐' },
    ],
  };
}

/** 家附近（演示）：种类决定能一起做什么，正式版来自 Places 附近搜索 */
export const NEARBY_PLACES: MapLocation[] = [
  {
    id: 'real:cafe',
    name: '街角咖啡店',
    area: 'real',
    icon: 'i-lucide-coffee',
    x: 70,
    y: 34,
    backdrop: 'cafe',
    indoor: true,
    blurb: '咖啡店',
    distanceKm: 0.3,
    activities: [
      { sceneId: 'date', label: '约会' },
      { sceneId: 'study', label: '一起自习' },
    ],
  },
  {
    id: 'real:ramen',
    name: '拉面店',
    area: 'real',
    icon: 'i-lucide-soup',
    x: 30,
    y: 70,
    backdrop: 'dining',
    indoor: true,
    blurb: '餐厅',
    distanceKm: 0.5,
    activities: [
      { sceneId: 'meal', label: '一起吃饭' },
      { sceneId: 'date', label: '约会' },
    ],
  },
  {
    id: 'real:park',
    name: '社区公园',
    area: 'real',
    icon: 'i-lucide-trees',
    x: 22,
    y: 26,
    backdrop: 'park',
    indoor: false,
    blurb: '公园',
    distanceKm: 0.8,
    activities: [
      { sceneId: 'exercise', label: '跑步 / 散步' },
      { sceneId: 'date', label: '散步约会' },
    ],
  },
  {
    id: 'real:library',
    name: '图书馆',
    area: 'real',
    icon: 'i-lucide-library-big',
    x: 78,
    y: 70,
    backdrop: 'library',
    indoor: true,
    blurb: '图书馆',
    distanceKm: 1.0,
    activities: [{ sceneId: 'study', label: '陪伴学习' }],
  },
  {
    id: 'real:gym',
    name: '健身房',
    area: 'real',
    icon: 'i-lucide-dumbbell',
    x: 86,
    y: 18,
    backdrop: 'gym',
    indoor: true,
    blurb: '健身房',
    distanceKm: 1.2,
    activities: [{ sceneId: 'exercise', label: '一起练' }],
  },
];

/** 你在外面（定位到离家有点远、又不在附近哪个认得的地方）：只用来在地图上标"你"、场景里写"你在外面" */
export function realOut(at: { lat: number; lng: number }, awayKm: number | null): MapLocation {
  return {
    id: REAL_OUT_ID,
    name: '外面',
    area: 'real',
    icon: 'i-lucide-navigation',
    x: 50,
    y: 20,
    backdrop: 'park',
    indoor: false,
    blurb: awayKm != null ? `离家 ${awayKm < 1 ? `${Math.round(awayKm * 1000)} 米` : `${awayKm.toFixed(1)} 公里`}` : '出门了',
    distanceKm: awayKm ?? undefined,
    lat: at.lat,
    lng: at.lng,
    activities: [
      { sceneId: 'music', label: '一起听歌' },
      { sceneId: 'exercise', label: '散步' },
    ],
  };
}
