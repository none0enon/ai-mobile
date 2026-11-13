import type { SceneId } from './scenes.ts';
import type { OutfitItem } from './types/rhythm.ts';

/**
 * 地图分两种：
 * - 每个角色有自己的"虚拟小世界"（World）：她的住处、学校、常去的地方，画在一张小地图上。
 *   她此刻在哪由她的模拟作息决定（Character.locationId）；你点地点就是"去她的世界找她"。
 * - 你在真实世界（Google Maps）：家、此刻的位置、附近可以一起去的地方（运行时注册，见 registerPlaces）。
 *   和她一起去真实地点时，她"来你这边"陪你；离开后她回到自己的世界。
 */
export type LocationArea = 'home' | 'campus' | 'city' | 'real';

export interface LocationActivity {
  sceneId: SceneId;
  label: string;
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
  /** 真实地点：地址、离家多远（Google Places 返回） */
  address?: string;
  distanceKm?: number;
  /** 真实地点的坐标（画在 Google 地图上） */
  lat?: number;
  lng?: number;
  /** Google Places 的地点 id、在 Google 地图里打开的链接 */
  placeId?: string;
  mapsUri?: string;
}

/** 小地图底图的图形（400×300 坐标），按 cls 上色（配色跟随主题） */
export type MapShapeClass = 'home' | 'campus' | 'park' | 'water' | 'river' | 'road' | 'road-line' | 'bldg' | 'roof' | 'track' | 'pool' | 'wheel' | 'wheel-spoke';
export type MapShape =
  | { kind: 'rect'; cls: MapShapeClass; x: number; y: number; w: number; h: number; r?: number }
  | { kind: 'path'; cls: MapShapeClass; d: string }
  | { kind: 'ellipse'; cls: MapShapeClass; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'circle'; cls: MapShapeClass; cx: number; cy: number; r: number };

/** 她一天的作息（和你用同一个时间）：几点在哪、在做什么。M3 由主动消息的 Cron 按它推进她的位置 */
export interface ScheduleSlot {
  /** HH:MM */
  from: string;
  to: string;
  locationId: string;
  status: string;
}

/** 她自己的生活：连线自习时她在学什么、饭搭子时她吃什么、平时穿什么（节律模板从这里来） */
export interface WorldLife {
  studyTask: string;
  meals: Record<'breakfast' | 'lunch' | 'dinner', string>;
  /** 衣柜：每套写中文名和 NovelAI tags */
  wardrobe?: Omit<OutfitItem, 'id'>[];
}

export interface World {
  id: string;
  characterId: string;
  name: string;
  blurb: string;
  /** 她的住处（哄睡、听歌、戳戳乐默认在这里） */
  homeId: string;
  areaLabels: Record<Exclude<LocationArea, 'real'>, string>;
  locations: MapLocation[];
  base: MapShape[];
  labels: { text: string; x: number; y: number }[];
  schedule: ScheduleSlot[];
  life: WorldLife;
}

const rect = (cls: MapShapeClass, x: number, y: number, w: number, h: number, r = 0): MapShape => ({ kind: 'rect', cls, x, y, w, h, r });
const path = (cls: MapShapeClass, d: string): MapShape => ({ kind: 'path', cls, d });

/** 苏晚的世界：小公寓、她读书的学校、城里约会的地方 */
const SUWAN_WORLD: World = {
  id: 'world-suwan',
  characterId: 'suwan',
  name: '苏晚的小世界',
  blurb: '她住的小公寓、读书的学校、周末常去的城里',
  homeId: 'home',
  areaLabels: { home: '住处', campus: '学校', city: '城里' },
  schedule: [
    { from: '00:00', to: '07:30', locationId: 'home', status: '睡觉中' },
    { from: '07:30', to: '08:30', locationId: 'home', status: '吃早饭' },
    { from: '08:30', to: '11:30', locationId: 'library', status: '自习中' },
    { from: '11:30', to: '12:30', locationId: 'canteen', status: '吃午饭' },
    { from: '12:30', to: '17:30', locationId: 'library', status: '写论文' },
    { from: '17:30', to: '18:30', locationId: 'canteen', status: '吃晚饭' },
    { from: '18:30', to: '19:30', locationId: 'riverside', status: '散步' },
    { from: '19:30', to: '22:00', locationId: 'library', status: '自习中' },
    { from: '22:00', to: '23:30', locationId: 'home', status: '在家看书' },
    { from: '23:30', to: '24:00', locationId: 'home', status: '准备睡了' },
  ],
  life: {
    studyTask: '课程论文第三章：宋词里的雨',
    meals: { breakfast: '自己煮的小馄饨', lunch: '食堂的麻辣烫', dinner: '后门那家砂锅粥' },
    wardrobe: [
      { kind: 'daily', name: '米色针织开衫配白衬衫', tags: 'beige cardigan, white blouse, long skirt' },
      { kind: 'daily', name: '浅蓝毛衣配格子裙', tags: 'light blue sweater, plaid skirt, black pantyhose' },
      { kind: 'sport', name: '浅灰运动套装', tags: 'grey track suit, ponytail, sneakers' },
      { kind: 'sleep', name: '小熊印花睡衣', tags: 'pajamas, bear print, hair down' },
      { kind: 'date', name: '酒红色针织连衣裙', tags: 'red knit dress, small shoulder bag, earrings' },
    ],
  },
  labels: [
    { text: '住处', x: 16, y: 112 },
    { text: '学校', x: 178, y: 148 },
    { text: '城里', x: 300, y: 296 },
  ],
  base: [
    rect('home', 6, 6, 130, 112, 18),
    rect('campus', 168, 6, 226, 150, 18),
    path('park', 'M0 196 C40 206 70 214 96 236 C118 256 126 280 132 300 L0 300 Z'),
    path('water', 'M292 300 C318 272 352 258 400 248 L400 300 Z'),
    path('river', 'M0 224 C44 232 80 250 100 272 C110 284 114 294 116 300'),
    path('road', 'M0 164 H400 M150 0 V300 M150 234 H300 M270 164 V300 M64 118 V164 M222 156 V164 M330 156 V164'),
    path('road-line', 'M0 164 H400 M150 0 V300'),
    rect('bldg', 22, 34, 22, 16, 3),
    rect('bldg', 96, 30, 22, 16, 3),
    rect('bldg', 96, 84, 22, 16, 3),
    path('roof', 'M19 35 L33 24 L47 35 Z M93 31 L107 20 L121 31 Z M93 85 L107 74 L121 85 Z'),
    rect('bldg', 204, 26, 58, 36, 6),
    rect('bldg', 304, 26, 54, 36, 6),
    { kind: 'ellipse', cls: 'track', cx: 256, cy: 114, rx: 38, ry: 21 },
    rect('pool', 324, 108, 48, 26, 5),
    rect('bldg', 94, 124, 48, 32, 6),
    rect('bldg', 14, 170, 96, 36, 8),
    rect('bldg', 166, 174, 88, 42, 8),
    rect('bldg', 316, 180, 68, 38, 10),
    rect('bldg', 104, 242, 16, 12, 2),
    rect('bldg', 124, 242, 16, 12, 2),
    rect('bldg', 104, 258, 16, 12, 2),
    rect('bldg', 124, 258, 16, 12, 2),
    { kind: 'circle', cls: 'wheel', cx: 264, cy: 231, r: 24 },
    path('wheel-spoke', 'M264 207 V255 M240 231 H288 M247 214 L281 248 M281 214 L247 248'),
  ],
  locations: [
    {
      id: 'home',
      name: '小公寓',
      area: 'home',
      icon: 'i-lucide-house',
      x: 15,
      y: 24,
      backdrop: 'bedroom',
      indoor: true,
      blurb: '她一个人住，卧室、餐桌、客厅',
      activities: [
        { sceneId: 'sleep', label: '卧室 · 哄睡' },
        { sceneId: 'read', label: '沙发 · 一起看书' },
        { sceneId: 'meal', label: '餐桌 · 一起吃饭' },
        { sceneId: 'music', label: '客厅 · 一起听歌' },
        { sceneId: 'watch', label: '客厅 · 一起看片' },
        { sceneId: 'game', label: '客厅 · 一起游戏' },
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
      activities: [
        { sceneId: 'study', label: '陪伴学习' },
        { sceneId: 'read', label: '一起看书' },
      ],
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
      backdrop: 'pool',
      indoor: true,
      blurb: '她在学蛙泳，还不太会换气',
      activities: [{ sceneId: 'exercise', label: '一起游泳' }],
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
        { sceneId: 'date', label: '约会' },
        { sceneId: 'study', label: '一起自习' },
        { sceneId: 'read', label: '一起看书' },
        { sceneId: 'game', label: '一起玩游戏' },
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
      activities: [{ sceneId: 'date', label: '约会' }],
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
      activities: [
        { sceneId: 'watch', label: '一起看电影' },
        { sceneId: 'date', label: '约会' },
      ],
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
        { sceneId: 'date', label: '约会' },
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
      activities: [{ sceneId: 'date', label: '约会' }],
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
      activities: [{ sceneId: 'date', label: '约会' }],
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
        { sceneId: 'date', label: '约会' },
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
      activities: [{ sceneId: 'date', label: '约会' }],
    },
  ],
};

/** 江屿的世界：体育学院的宿舍、田径场、游泳馆，江边的夜宵摊和旧码头 */
const JIANGYU_WORLD: World = {
  id: 'world-jiangyu',
  characterId: 'jiangyu',
  name: '江屿的小世界',
  blurb: '体育学院的宿舍、训练场，和江边那条他常夜跑的路',
  homeId: 'jy-dorm',
  areaLabels: { home: '宿舍区', campus: '体育学院', city: '江边' },
  schedule: [
    { from: '00:00', to: '05:50', locationId: 'jy-dorm', status: '睡觉中' },
    { from: '05:50', to: '07:00', locationId: 'jy-track', status: '晨跑' },
    { from: '07:00', to: '08:00', locationId: 'jy-canteen', status: '吃早饭' },
    { from: '08:00', to: '11:30', locationId: 'jy-study', status: '上课中' },
    { from: '11:30', to: '12:30', locationId: 'jy-canteen', status: '吃午饭' },
    { from: '12:30', to: '14:00', locationId: 'jy-dorm', status: '午睡' },
    { from: '14:00', to: '17:00', locationId: 'jy-pool', status: '训练中' },
    { from: '17:00', to: '18:00', locationId: 'jy-canteen', status: '吃晚饭' },
    { from: '18:00', to: '19:30', locationId: 'jy-weights', status: '力量训练' },
    { from: '19:30', to: '21:00', locationId: 'jy-pool', status: '加练' },
    { from: '21:00', to: '22:00', locationId: 'jy-pool', status: '刚游完泳' },
    { from: '22:00', to: '23:00', locationId: 'jy-dorm', status: '拉伸' },
    { from: '23:00', to: '24:00', locationId: 'jy-dorm', status: '睡觉中' },
  ],
  life: {
    studyTask: '看 200 米自由泳的比赛录像',
    meals: { breakfast: '食堂的鸡蛋和燕麦', lunch: '运动员食堂的鸡胸肉饭', dinner: '牛肉面加两个蛋' },
    wardrobe: [
      { kind: 'daily', name: '黑色连帽卫衣配牛仔裤', tags: 'black hoodie, jeans, sneakers' },
      { kind: 'sport', name: '队服训练外套', tags: 'track jacket, sportswear, towel around neck' },
      { kind: 'sleep', name: '灰色 T 恤和短裤', tags: 'grey t-shirt, shorts' },
      { kind: 'date', name: '白衬衫配黑色长裤', tags: 'white shirt, rolled up sleeves, black pants' },
    ],
  },
  labels: [
    { text: '宿舍区', x: 14, y: 108 },
    { text: '体育学院', x: 154, y: 22 },
    { text: '江边', x: 196, y: 288 },
  ],
  base: [
    rect('home', 6, 6, 118, 108, 18),
    rect('campus', 146, 6, 248, 152, 18),
    path('park', 'M0 196 C34 200 66 210 92 226 L0 232 Z'),
    path('water', 'M0 240 C70 228 140 252 210 242 C280 232 340 248 400 238 L400 300 L0 300 Z'),
    path('road', 'M0 168 H400 M136 0 V226 M136 86 H146 M270 168 V226 M0 230 C70 218 140 242 210 232 C280 222 340 238 400 228'),
    path('road-line', 'M0 168 H400 M136 0 V226'),
    rect('bldg', 22, 30, 34, 22, 3),
    rect('bldg', 70, 30, 34, 22, 3),
    rect('bldg', 22, 66, 34, 22, 3),
    rect('bldg', 70, 66, 34, 22, 3),
    { kind: 'ellipse', cls: 'track', cx: 208, cy: 78, rx: 44, ry: 26 },
    rect('pool', 318, 40, 62, 32, 6),
    rect('bldg', 262, 118, 44, 24, 5),
    rect('bldg', 336, 118, 50, 26, 6),
    rect('bldg', 180, 124, 50, 22, 5),
    rect('bldg', 48, 182, 14, 10, 2),
    rect('bldg', 66, 182, 14, 10, 2),
    rect('bldg', 84, 182, 14, 10, 2),
    rect('bldg', 48, 196, 14, 10, 2),
    rect('bldg', 66, 196, 14, 10, 2),
    rect('bldg', 160, 178, 58, 34, 6),
    rect('bldg', 250, 178, 50, 32, 8),
    rect('bldg', 330, 246, 46, 8, 2),
  ],
  locations: [
    {
      id: 'jy-dorm',
      name: '宿舍',
      area: 'home',
      icon: 'i-lucide-bed-double',
      x: 16,
      y: 22,
      backdrop: 'bedroom',
      indoor: true,
      blurb: '四人间，他睡靠窗的上铺',
      activities: [
        { sceneId: 'sleep', label: '宿舍 · 哄睡' },
        { sceneId: 'music', label: '宿舍 · 一起听歌' },
        { sceneId: 'watch', label: '宿舍 · 一起看片' },
        { sceneId: 'read', label: '宿舍 · 一起看书' },
        { sceneId: 'game', label: '宿舍 · 一起游戏' },
        { sceneId: 'poke', label: '宿舍 · 戳戳乐' },
      ],
    },
    {
      id: 'jy-track',
      name: '田径场',
      area: 'campus',
      icon: 'i-lucide-footprints',
      x: 52,
      y: 26,
      backdrop: 'park',
      indoor: false,
      blurb: '早上六点，他在这里等你',
      activities: [{ sceneId: 'exercise', label: '晨跑' }],
    },
    {
      id: 'jy-pool',
      name: '游泳馆',
      area: 'campus',
      icon: 'i-lucide-waves',
      x: 87,
      y: 19,
      backdrop: 'pool',
      indoor: true,
      blurb: '50 米池，他的地盘',
      activities: [{ sceneId: 'exercise', label: '一起游泳' }],
    },
    {
      id: 'jy-weights',
      name: '力量房',
      area: 'campus',
      icon: 'i-lucide-dumbbell',
      x: 68,
      y: 43,
      backdrop: 'gym',
      indoor: true,
      blurb: '他会帮你看动作',
      activities: [{ sceneId: 'exercise', label: '一起练' }],
    },
    {
      id: 'jy-canteen',
      name: '食堂',
      area: 'campus',
      icon: 'i-lucide-utensils',
      x: 90,
      y: 44,
      backdrop: 'dining',
      indoor: true,
      blurb: '运动员食堂，高蛋白套餐管饱',
      activities: [{ sceneId: 'meal', label: '一起吃饭' }],
    },
    {
      id: 'jy-study',
      name: '自习室',
      area: 'campus',
      icon: 'i-lucide-book-open',
      x: 51,
      y: 46,
      backdrop: 'library',
      indoor: true,
      blurb: '你学你的，他看比赛录像',
      activities: [{ sceneId: 'study', label: '陪伴学习' }],
    },
    {
      id: 'jy-bbq',
      name: '夜宵摊',
      area: 'city',
      icon: 'i-lucide-flame',
      x: 18,
      y: 64,
      backdrop: 'night-market',
      indoor: false,
      blurb: '训练完的烧烤',
      activities: [
        { sceneId: 'meal', label: '吃夜宵' },
        { sceneId: 'game', label: '边吃边玩游戏' },
        { sceneId: 'date', label: '约会' },
      ],
    },
    {
      id: 'jy-cinema',
      name: '老影院',
      area: 'city',
      icon: 'i-lucide-clapperboard',
      x: 46,
      y: 69,
      backdrop: 'cinema',
      indoor: true,
      blurb: '只放老片子的二轮影院',
      activities: [
        { sceneId: 'watch', label: '一起看电影' },
        { sceneId: 'date', label: '约会' },
      ],
    },
    {
      id: 'jy-arcade',
      name: '电玩城',
      area: 'city',
      icon: 'i-lucide-gamepad-2',
      x: 69,
      y: 64,
      backdrop: 'amusement',
      indoor: true,
      blurb: '投篮机他从没输过',
      activities: [{ sceneId: 'date', label: '约会' }],
    },
    {
      id: 'jy-river',
      name: '江堤',
      area: 'city',
      icon: 'i-lucide-trees',
      x: 12,
      y: 85,
      backdrop: 'park',
      indoor: false,
      blurb: '夜跑、吹江风',
      activities: [
        { sceneId: 'exercise', label: '夜跑' },
        { sceneId: 'date', label: '江边散步' },
      ],
    },
    {
      id: 'jy-pier',
      name: '旧码头',
      area: 'city',
      icon: 'i-lucide-anchor',
      x: 88,
      y: 83,
      backdrop: 'seaside',
      indoor: false,
      blurb: '看船、看日落',
      activities: [{ sceneId: 'date', label: '约会' }],
    },
  ],
};

export const WORLDS: World[] = [SUWAN_WORLD, JIANGYU_WORLD];

/** 演示角色的世界里的地点 */
export const LOCATIONS: MapLocation[] = WORLDS.flatMap((w) => w.locations);

/**
 * 导入的角色"建世界"后生成的世界：存在她的 id 下（本机库），打开 App 时登记进来（设计文档 §5.4）。
 * 地点 id 带上角色 id 的前缀，所以和别的世界不会撞
 */
const builtWorlds = new Map<string, World>();
export function registerWorld(w: World) {
  builtWorlds.set(w.characterId, w);
}
export function unregisterWorld(characterId: string) {
  builtWorlds.delete(characterId);
}
function allWorlds(): World[] {
  return [...builtWorlds.values(), ...WORLDS];
}

/** 真实世界的地点（家、附近的店）：运行时由地图服务注册进来 */
const realPlaces = new Map<string, MapLocation>();
export function registerPlaces(list: MapLocation[]) {
  for (const l of list) realPlaces.set(l.id, l);
}

export function getLocation(id: string | null | undefined): MapLocation | undefined {
  if (!id) return undefined;
  return LOCATIONS.find((l) => l.id === id) ?? builtWorlds.get(worldIdOf(id) ?? '')?.locations.find((l) => l.id === id) ?? findBuilt(id) ?? realPlaces.get(id);
}

/** 生成的世界里地点 id 是"角色 id/地点"：先按前缀找，找不到再挨个找 */
function worldIdOf(locationId: string): string | null {
  const i = locationId.indexOf('/');
  return i > 0 ? locationId.slice(0, i) : null;
}
function findBuilt(id: string): MapLocation | undefined {
  for (const w of builtWorlds.values()) {
    const l = w.locations.find((x) => x.id === id);
    if (l) return l;
  }
  return undefined;
}

export function isRealPlace(l: MapLocation | null | undefined): boolean {
  return l?.area === 'real';
}

/** 这个角色有没有自己的小世界（导入的角色在"建世界"之前没有） */
export function hasOwnWorld(characterId: string | null | undefined): boolean {
  return allWorlds().some((w) => w.characterId === characterId);
}

/** 角色的世界；还没有自己世界的角色（刚导入、还没"建世界"）先借用第一个世界 */
export function worldOf(characterId: string | null | undefined): World {
  return allWorlds().find((w) => w.characterId === characterId) ?? (WORLDS[0] as World);
}

export function worldOfLocation(locationId: string | null | undefined): World | undefined {
  return allWorlds().find((w) => w.locations.some((l) => l.id === locationId));
}

/** 某件事在她的世界里默认去哪（从聊天的 ＋ 面板直接进场景时用）：住处能做就在住处，否则去第一个能做的地方 */
export function defaultLocationFor(sceneId: SceneId, characterId?: string | null): MapLocation {
  const w = worldOf(characterId);
  const home = w.locations.find((l) => l.id === w.homeId);
  if (home?.activities.some((a) => a.sceneId === sceneId)) return home;
  return w.locations.find((l) => l.activities.some((a) => a.sceneId === sceneId)) ?? home ?? (w.locations[0] as MapLocation);
}

/** 她此刻按作息在哪、在做什么 */
export function slotAt(world: World, now: Date): ScheduleSlot | undefined {
  const t = now.getHours() * 60 + now.getMinutes();
  const min = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return world.schedule.find((s) => min(s.from) <= t && t < min(s.to)) ?? world.schedule.at(-1);
}

/** 地点所在片区的名字 */
export function areaLabel(l: MapLocation): string {
  if (l.area === 'real') return '你的世界';
  return worldOfLocation(l.id)?.areaLabels[l.area] ?? '';
}
