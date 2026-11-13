
/**
 * 装修小屋的数据和规则（不碰 three.js：存档、给模型的描述、她的布置方案都在这里算）。
 *
 * 坐标：一格 = 1。地面 W × D 格，x 从左墙（x = 0）往右，z 从后墙（z = 0）往前（朝镜头）。
 * 家具的 x、z 是占地中心；占地的边对齐半格。turn 是朝向：0 朝前（+z）、1 朝右、2 朝后、3 朝左。
 * 一套小屋有好几个房间（一开始 6 个，最多 MAX_ROOMS 个），每个房间各有各的大小、墙纸、地面和家具；画面上一次看一间。
 * 挂墙的东西：wall 是哪面墙（后墙 / 左墙），后墙上的用 x 表示沿墙位置、左墙上的用 z，y 是中心离地多高。
 * 放在台面上的小东西：on 是下面那件家具的 id（桌子挪了、转了，上面的东西一起跟着）。
 */

export type Turn = 0 | 1 | 2 | 3;
export type WallSide = 'back' | 'left';
export type DecorCategory = 'seat' | 'table' | 'bed' | 'kitchen' | 'bath' | 'study' | 'tech' | 'rug' | 'plant' | 'light' | 'small' | 'wall';
export type Placement = 'floor' | 'rug' | 'top' | 'wall';

export interface DecorItem {
  id: string;
  kind: string;
  x: number;
  z: number;
  /** 挂墙的东西：中心离地多高 */
  y?: number;
  turn: Turn;
  wall?: WallSide;
  /** 放在哪件家具的台面上 */
  on?: string;
  /** 主色；不写用目录里的默认色 */
  color?: string;
  /** 谁放的 */
  by?: 'you' | 'her';
}

export interface Finish {
  finish: string;
  color: string;
}

export interface DecorRoom {
  /** 房间的编号（一套小屋里不重复） */
  id: string;
  /** 哪种房间（ROOM_TYPES 的 id）：只管图标，家具随便摆 */
  type: string;
  name: string;
  w: number;
  d: number;
  wall: Finish;
  floor: Finish;
  items: DecorItem[];
}

export interface CatalogItem {
  id: string;
  name: string;
  cat: DecorCategory;
  /** 占地（朝前时）：左右 w、前后 d；挂墙的是沿墙宽 w、高 h */
  w: number;
  d: number;
  h: number;
  place: Placement;
  /** 台面高度：上面能放小东西 */
  top?: number;
  /** 能坐的位置（家具自己的坐标，朝前时），和坐垫高度 */
  seats?: [number, number][];
  seatH?: number;
  /** 能躺的位置（家具自己的坐标，身子沿前后方向，头朝后），和床面高度 */
  beds?: [number, number][];
  bedH?: number;
  /** 晚上会亮 */
  light?: boolean;
  /** 挂墙的默认高度（中心） */
  wallY?: number;
  /** 能选的颜色，第一个是默认 */
  colors: string[];
  /** 没说放哪儿时靠墙放（床、柜子、书桌……） */
  hug?: boolean;
  /** 小东西没说放哪儿时先找这些家具的台面（电视放电视柜上、电脑放书桌上） */
  prefer?: string[];
}

export const CATEGORIES: { id: DecorCategory; label: string; icon: string }[] = [
  { id: 'seat', label: '座椅', icon: 'i-lucide-armchair' },
  { id: 'table', label: '桌台', icon: 'i-lucide-table-2' },
  { id: 'bed', label: '床和柜子', icon: 'i-lucide-bed-double' },
  { id: 'kitchen', label: '厨房', icon: 'i-lucide-cooking-pot' },
  { id: 'bath', label: '卫浴', icon: 'i-lucide-bath' },
  { id: 'study', label: '书房', icon: 'i-lucide-book-open' },
  { id: 'tech', label: '屏幕电器', icon: 'i-lucide-monitor' },
  { id: 'rug', label: '地毯', icon: 'i-lucide-rectangle-horizontal' },
  { id: 'plant', label: '绿植', icon: 'i-lucide-sprout' },
  { id: 'light', label: '灯', icon: 'i-lucide-lamp' },
  { id: 'small', label: '小物', icon: 'i-lucide-coffee' },
  { id: 'wall', label: '墙上', icon: 'i-lucide-frame' },
];

/** 调色盘：名字给模型和读屏用 */
export const PALETTE: { name: string; hex: string }[] = [
  { name: '奶油', hex: '#f3e9d2' },
  { name: '纯白', hex: '#f7f6f2' },
  { name: '樱花粉', hex: '#f4b6c2' },
  { name: '蜜桃', hex: '#f7c59f' },
  { name: '珊瑚', hex: '#ee8f7a' },
  { name: '鹅黄', hex: '#f6e09a' },
  { name: '抹茶', hex: '#b9d38f' },
  { name: '薄荷', hex: '#b5dfc9' },
  { name: '雾蓝', hex: '#a9c4e0' },
  { name: '天蓝', hex: '#7fb3e0' },
  { name: '薰衣草', hex: '#c9b8e8' },
  { name: '葡萄紫', hex: '#9b7fc4' },
  { name: '原木', hex: '#d2a679' },
  { name: '焦糖', hex: '#c98a4b' },
  { name: '胡桃', hex: '#8a5a3b' },
  { name: '浅灰', hex: '#c9ccd2' },
  { name: '炭灰', hex: '#5b5e66' },
  { name: '墨绿', hex: '#4f7a5e' },
  { name: '酒红', hex: '#9c3d4f' },
  { name: '藏青', hex: '#34466b' },
];

/** 调色盘之外、只有个别东西用的颜色（水果）：只管名字 */
const EXTRA_COLORS: { name: string; hex: string }[] = [
  { name: '苹果红', hex: '#e2574c' },
  { name: '橙', hex: '#f5a23a' },
  { name: '香蕉黄', hex: '#f6d55c' },
  { name: '青柠', hex: '#a8cf5f' },
];
const NAMED = [...PALETTE, ...EXTRA_COLORS];
const P = Object.fromEntries(NAMED.map((c) => [c.name, c.hex])) as Record<string, string>;
const SOFT = [P['樱花粉']!, P['雾蓝']!, P['薄荷']!, P['薰衣草']!, P['奶油']!, P['鹅黄']!, P['炭灰']!, P['墨绿']!];
const WOOD = [P['原木']!, P['胡桃']!, P['纯白']!, P['奶油']!, P['炭灰']!, P['樱花粉']!, P['雾蓝']!];
const CABINET = [P['纯白']!, P['奶油']!, P['原木']!, P['浅灰']!, P['炭灰']!, P['薄荷']!, P['雾蓝']!, P['樱花粉']!];
const APPLIANCE = [P['纯白']!, P['浅灰']!, P['炭灰']!, P['奶油']!, P['薄荷']!, P['樱花粉']!, P['雾蓝']!];
const CERAMIC = [P['纯白']!, P['奶油']!, P['樱花粉']!, P['薄荷']!, P['雾蓝']!, P['鹅黄']!];
const TABLES = ['dining', 'diningLong', 'counter', 'coffee', 'lowtable'];

export const CATALOG: CatalogItem[] = [
  // 座椅
  { id: 'sofa', name: '双人沙发', cat: 'seat', w: 2, d: 1, h: 0.8, place: 'floor', seats: [[-0.48, 0.08], [0.48, 0.08]], seatH: 0.3, hug: true, colors: SOFT },
  { id: 'armchair', name: '单人沙发', cat: 'seat', w: 1, d: 1, h: 0.8, place: 'floor', seats: [[0, 0.08]], seatH: 0.3, colors: SOFT },
  { id: 'chair', name: '木椅子', cat: 'seat', w: 1, d: 1, h: 0.85, place: 'floor', seats: [[0, 0.02]], seatH: 0.32, colors: WOOD },
  { id: 'stool', name: '圆凳', cat: 'seat', w: 1, d: 1, h: 0.32, place: 'floor', seats: [[0, 0]], seatH: 0.32, colors: WOOD },
  { id: 'beanbag', name: '懒人沙发', cat: 'seat', w: 1, d: 1, h: 0.45, place: 'floor', seats: [[0, 0.05]], seatH: 0.22, colors: SOFT },
  { id: 'cushion', name: '坐垫', cat: 'seat', w: 1, d: 1, h: 0.1, place: 'floor', seats: [[0, 0]], seatH: 0.1, colors: SOFT },
  { id: 'officeChair', name: '电脑椅', cat: 'seat', w: 1, d: 1, h: 0.9, place: 'floor', seats: [[0, 0.02]], seatH: 0.35, colors: [P['炭灰']!, P['樱花粉']!, P['雾蓝']!, P['薄荷']!, P['奶油']!, P['纯白']!] },
  // 桌台
  { id: 'coffee', name: '圆茶几', cat: 'table', w: 1, d: 1, h: 0.3, place: 'floor', top: 0.3, colors: WOOD },
  { id: 'lowtable', name: '长茶几', cat: 'table', w: 2, d: 1, h: 0.3, place: 'floor', top: 0.3, colors: WOOD },
  { id: 'desk', name: '书桌', cat: 'table', w: 2, d: 1, h: 0.6, place: 'floor', top: 0.6, hug: true, colors: WOOD },
  { id: 'dining', name: '圆餐桌', cat: 'table', w: 2, d: 2, h: 0.6, place: 'floor', top: 0.6, colors: WOOD },
  { id: 'diningLong', name: '长餐桌', cat: 'table', w: 3, d: 1.5, h: 0.6, place: 'floor', top: 0.6, colors: WOOD },
  { id: 'nightstand', name: '床头柜', cat: 'table', w: 1, d: 1, h: 0.45, place: 'floor', top: 0.45, hug: true, colors: WOOD },
  { id: 'tvstand', name: '电视柜', cat: 'table', w: 2, d: 1, h: 0.4, place: 'floor', top: 0.4, hug: true, colors: WOOD },
  // 床和柜子
  { id: 'bed', name: '双人床', cat: 'bed', w: 2, d: 3, h: 0.9, place: 'floor', beds: [[-0.45, 0.1], [0.45, 0.1]], bedH: 0.4, hug: true, colors: SOFT },
  { id: 'bedsingle', name: '单人床', cat: 'bed', w: 1, d: 2, h: 0.85, place: 'floor', beds: [[0, 0.05]], bedH: 0.4, hug: true, colors: SOFT },
  { id: 'wardrobe', name: '衣柜', cat: 'bed', w: 2, d: 1, h: 1.9, place: 'floor', hug: true, colors: WOOD },
  { id: 'bookshelf', name: '书架', cat: 'bed', w: 2, d: 1, h: 1.6, place: 'floor', hug: true, colors: WOOD },
  { id: 'dresser', name: '五斗柜', cat: 'bed', w: 1, d: 1, h: 0.8, place: 'floor', top: 0.8, hug: true, colors: WOOD },
  // 厨房
  { id: 'stove', name: '灶台', cat: 'kitchen', w: 2, d: 1, h: 0.62, place: 'floor', top: 0.62, hug: true, colors: CABINET },
  { id: 'counter', name: '料理台', cat: 'kitchen', w: 2, d: 1, h: 0.62, place: 'floor', top: 0.62, hug: true, colors: CABINET },
  { id: 'sink', name: '水槽', cat: 'kitchen', w: 2, d: 1, h: 0.9, place: 'floor', hug: true, colors: CABINET },
  { id: 'fridge', name: '冰箱', cat: 'kitchen', w: 1, d: 1, h: 1.75, place: 'floor', hug: true, colors: APPLIANCE },
  { id: 'hood', name: '油烟机', cat: 'kitchen', w: 1.5, d: 0.5, h: 0.6, place: 'wall', wallY: 1.75, colors: APPLIANCE },
  { id: 'microwave', name: '微波炉', cat: 'kitchen', w: 1, d: 0.5, h: 0.3, place: 'top', prefer: ['counter', 'dresser', 'washer', 'tvstand'], colors: APPLIANCE },
  { id: 'airfryer', name: '空气炸锅', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.36, place: 'top', prefer: ['counter', 'dining', 'diningLong'], colors: [P['炭灰']!, P['纯白']!, P['薄荷']!, P['樱花粉']!, P['奶油']!] },
  { id: 'cooker', name: '电煮锅', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.25, place: 'top', prefer: ['counter', 'stove', 'dining', 'diningLong'], colors: [P['纯白']!, P['樱花粉']!, P['薄荷']!, P['鹅黄']!, P['珊瑚']!] },
  { id: 'bowls', name: '碗筷', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.14, place: 'top', prefer: TABLES, colors: CERAMIC },
  { id: 'plates', name: '盘子', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.08, place: 'top', prefer: TABLES, colors: CERAMIC },
  { id: 'fruitBasket', name: '水果篮', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.3, place: 'top', prefer: TABLES, colors: [P['原木']!, P['焦糖']!, P['纯白']!, P['樱花粉']!] },
  { id: 'apple', name: '苹果', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.16, place: 'top', prefer: TABLES, colors: [P['苹果红']!, P['青柠']!, P['鹅黄']!] },
  { id: 'banana', name: '香蕉', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.12, place: 'top', prefer: TABLES, colors: [P['香蕉黄']!, P['青柠']!] },
  { id: 'orange', name: '橙子', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.2, place: 'top', prefer: TABLES, colors: [P['橙']!, P['香蕉黄']!, P['青柠']!] },
  { id: 'watermelon', name: '西瓜', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.24, place: 'top', prefer: TABLES, colors: [P['墨绿']!, P['抹茶']!] },
  { id: 'grapes', name: '葡萄', cat: 'kitchen', w: 0.5, d: 0.5, h: 0.16, place: 'top', prefer: TABLES, colors: [P['葡萄紫']!, P['青柠']!, P['酒红']!] },
  // 卫浴
  { id: 'toilet', name: '马桶', cat: 'bath', w: 1, d: 1, h: 0.8, place: 'floor', seats: [[0, 0.08]], seatH: 0.4, hug: true, colors: CERAMIC },
  { id: 'washbasin', name: '洗手台', cat: 'bath', w: 1, d: 1, h: 0.95, place: 'floor', hug: true, colors: CABINET },
  { id: 'bathtub', name: '浴缸', cat: 'bath', w: 1, d: 2, h: 0.55, place: 'floor', beds: [[0, 0.05]], bedH: 0.2, hug: true, colors: CERAMIC },
  { id: 'washer', name: '洗衣机', cat: 'bath', w: 1, d: 1, h: 0.85, place: 'floor', top: 0.85, hug: true, colors: APPLIANCE },
  { id: 'mirror', name: '镜子', cat: 'bath', w: 1, d: 0.1, h: 1, place: 'wall', wallY: 1.5, colors: [P['纯白']!, P['原木']!, P['炭灰']!, P['樱花粉']!, P['鹅黄']!] },
  { id: 'towel', name: '毛巾架', cat: 'bath', w: 1, d: 0.15, h: 0.5, place: 'wall', wallY: 1.2, colors: [P['樱花粉']!, P['雾蓝']!, P['薄荷']!, P['纯白']!, P['鹅黄']!] },
  // 书房
  { id: 'books', name: '一摞书', cat: 'study', w: 0.5, d: 0.5, h: 0.25, place: 'top', prefer: ['desk', 'nightstand', 'coffee'], colors: [P['雾蓝']!, P['珊瑚']!, P['抹茶']!, P['薰衣草']!] },
  { id: 'openbook', name: '翻开的书', cat: 'study', w: 0.5, d: 0.5, h: 0.06, place: 'top', prefer: ['desk', 'coffee', 'nightstand', 'lowtable'], colors: [P['珊瑚']!, P['雾蓝']!, P['抹茶']!, P['薰衣草']!, P['炭灰']!] },
  { id: 'notepad', name: '纸和笔', cat: 'study', w: 0.5, d: 0.5, h: 0.06, place: 'top', prefer: ['desk', 'dining', 'diningLong', 'coffee'], colors: [P['鹅黄']!, P['樱花粉']!, P['雾蓝']!, P['薄荷']!, P['炭灰']!] },
  { id: 'penholder', name: '笔筒', cat: 'study', w: 0.5, d: 0.5, h: 0.26, place: 'top', prefer: ['desk', 'dresser'], colors: [P['雾蓝']!, P['樱花粉']!, P['原木']!, P['纯白']!, P['炭灰']!] },
  { id: 'deskclock', name: '桌面时钟', cat: 'study', w: 0.5, d: 0.5, h: 0.26, place: 'top', prefer: ['desk', 'nightstand', 'dresser'], colors: [P['樱花粉']!, P['薄荷']!, P['鹅黄']!, P['纯白']!, P['炭灰']!] },
  { id: 'printer', name: '打印机', cat: 'study', w: 1, d: 0.5, h: 0.32, place: 'top', prefer: ['dresser', 'desk', 'tvstand', 'counter'], colors: APPLIANCE },
  // 地毯
  { id: 'rugRound', name: '圆地毯', cat: 'rug', w: 2, d: 2, h: 0.02, place: 'rug', colors: [P['奶油']!, P['樱花粉']!, P['雾蓝']!, P['薄荷']!, P['薰衣草']!, P['鹅黄']!] },
  { id: 'rugRect', name: '长地毯', cat: 'rug', w: 3, d: 2, h: 0.02, place: 'rug', colors: [P['雾蓝']!, P['奶油']!, P['樱花粉']!, P['抹茶']!, P['薰衣草']!, P['炭灰']!] },
  { id: 'rugHeart', name: '爱心地毯', cat: 'rug', w: 2, d: 2, h: 0.02, place: 'rug', colors: [P['樱花粉']!, P['珊瑚']!, P['薰衣草']!, P['奶油']!] },
  { id: 'rugMat', name: '小地垫', cat: 'rug', w: 1, d: 1, h: 0.02, place: 'rug', colors: [P['鹅黄']!, P['薄荷']!, P['樱花粉']!, P['雾蓝']!] },
  // 绿植
  { id: 'plantTall', name: '龟背竹', cat: 'plant', w: 1, d: 1, h: 1.2, place: 'floor', hug: true, colors: [P['奶油']!, P['纯白']!, P['珊瑚']!, P['炭灰']!, P['雾蓝']!] },
  { id: 'tree', name: '琴叶榕', cat: 'plant', w: 1, d: 1, h: 1.7, place: 'floor', hug: true, colors: [P['纯白']!, P['原木']!, P['炭灰']!, P['珊瑚']!] },
  { id: 'pot', name: '小盆栽', cat: 'plant', w: 0.5, d: 0.5, h: 0.35, place: 'top', prefer: ['desk', 'dresser', 'coffee'], colors: [P['珊瑚']!, P['纯白']!, P['雾蓝']!, P['鹅黄']!] },
  { id: 'cactus', name: '仙人掌', cat: 'plant', w: 0.5, d: 0.5, h: 0.4, place: 'top', prefer: ['desk', 'nightstand'], colors: [P['原木']!, P['樱花粉']!, P['纯白']!, P['雾蓝']!] },
  { id: 'vase', name: '花瓶', cat: 'plant', w: 0.5, d: 0.5, h: 0.45, place: 'top', prefer: ['dining', 'dresser', 'coffee'], colors: [P['雾蓝']!, P['纯白']!, P['樱花粉']!, P['薰衣草']!] },
  // 灯
  { id: 'floorLamp', name: '落地灯', cat: 'light', w: 1, d: 1, h: 1.6, place: 'floor', light: true, hug: true, colors: [P['奶油']!, P['樱花粉']!, P['薄荷']!, P['鹅黄']!, P['纯白']!] },
  { id: 'deskLamp', name: '台灯', cat: 'light', w: 0.5, d: 0.5, h: 0.45, place: 'top', light: true, prefer: ['desk', 'nightstand', 'dresser'], colors: [P['鹅黄']!, P['樱花粉']!, P['薄荷']!, P['纯白']!] },
  { id: 'candle', name: '香薰蜡烛', cat: 'light', w: 0.5, d: 0.5, h: 0.2, place: 'top', light: true, prefer: ['nightstand', 'coffee', 'dresser'], colors: [P['樱花粉']!, P['薰衣草']!, P['奶油']!, P['薄荷']!] },
  { id: 'fairy', name: '串灯', cat: 'light', w: 2, d: 0.2, h: 0.5, place: 'wall', wallY: 2.05, light: true, colors: [P['鹅黄']!, P['樱花粉']!, P['天蓝']!, P['薄荷']!] },
  // 小物
  { id: 'mug', name: '马克杯', cat: 'small', w: 0.5, d: 0.5, h: 0.14, place: 'top', prefer: ['coffee', 'lowtable', 'desk', 'dining'], colors: [P['纯白']!, P['樱花粉']!, P['雾蓝']!, P['鹅黄']!] },
  { id: 'frame', name: '相框', cat: 'small', w: 0.5, d: 0.5, h: 0.3, place: 'top', prefer: ['nightstand', 'dresser', 'desk'], colors: [P['原木']!, P['纯白']!, P['樱花粉']!, P['炭灰']!] },
  { id: 'bear', name: '小熊玩偶', cat: 'small', w: 0.5, d: 0.5, h: 0.45, place: 'top', colors: [P['原木']!, P['奶油']!, P['樱花粉']!, P['浅灰']!] },
  { id: 'cat', name: '猫咪', cat: 'small', w: 0.5, d: 0.5, h: 0.4, place: 'top', colors: [P['鹅黄']!, P['炭灰']!, P['纯白']!, P['焦糖']!] },
  { id: 'fishbowl', name: '金鱼缸', cat: 'small', w: 0.5, d: 0.5, h: 0.35, place: 'top', prefer: ['dresser', 'desk', 'tvstand'], colors: [P['天蓝']!, P['薄荷']!] },
  // 屏幕电器
  { id: 'monitor', name: '显示屏', cat: 'tech', w: 1, d: 0.5, h: 0.62, place: 'top', prefer: ['desk', 'tvstand', 'dresser'], colors: [P['炭灰']!, P['纯白']!, P['樱花粉']!, P['雾蓝']!] },
  { id: 'tablet', name: '平板', cat: 'tech', w: 0.5, d: 0.5, h: 0.3, place: 'top', prefer: ['desk', 'coffee', 'nightstand', 'lowtable'], colors: [P['浅灰']!, P['樱花粉']!, P['炭灰']!, P['雾蓝']!, P['薄荷']!] },
  { id: 'phone', name: '手机', cat: 'tech', w: 0.5, d: 0.5, h: 0.03, place: 'top', prefer: ['nightstand', 'desk', 'coffee', 'lowtable'], colors: [P['炭灰']!, P['樱花粉']!, P['纯白']!, P['雾蓝']!, P['薰衣草']!] },
  { id: 'tv', name: '电视', cat: 'tech', w: 1.5, d: 0.5, h: 0.85, place: 'top', prefer: ['tvstand', 'dresser', 'lowtable'], colors: [P['炭灰']!, P['纯白']!, P['樱花粉']!] },
  { id: 'laptop', name: '笔记本电脑', cat: 'tech', w: 0.5, d: 0.5, h: 0.25, place: 'top', prefer: ['desk', 'dining', 'lowtable'], colors: [P['浅灰']!, P['樱花粉']!, P['炭灰']!, P['雾蓝']!] },
  { id: 'console', name: '游戏机', cat: 'tech', w: 0.5, d: 0.5, h: 0.12, place: 'top', prefer: ['tvstand', 'lowtable', 'coffee'], colors: [P['珊瑚']!, P['天蓝']!, P['纯白']!, P['炭灰']!] },
  { id: 'speaker', name: '音箱', cat: 'tech', w: 0.5, d: 0.5, h: 0.6, place: 'top', prefer: ['tvstand', 'desk', 'dresser'], colors: [P['原木']!, P['炭灰']!, P['纯白']!] },
  // 墙上
  { id: 'window', name: '窗户', cat: 'wall', w: 1.5, d: 0.2, h: 1.3, place: 'wall', wallY: 1.35, colors: [P['纯白']!, P['原木']!, P['雾蓝']!, P['樱花粉']!] },
  { id: 'painting', name: '挂画', cat: 'wall', w: 1, d: 0.1, h: 0.8, place: 'wall', wallY: 1.55, colors: [P['原木']!, P['纯白']!, P['炭灰']!, P['樱花粉']!] },
  { id: 'clock', name: '挂钟', cat: 'wall', w: 0.6, d: 0.1, h: 0.6, place: 'wall', wallY: 1.95, colors: [P['纯白']!, P['樱花粉']!, P['薄荷']!, P['鹅黄']!] },
  { id: 'shelf', name: '墙架', cat: 'wall', w: 1.5, d: 0.3, h: 0.5, place: 'wall', wallY: 1.45, colors: WOOD },
  { id: 'whiteboard', name: '白板', cat: 'wall', w: 1.5, d: 0.1, h: 1, place: 'wall', wallY: 1.5, colors: [P['浅灰']!, P['纯白']!, P['原木']!, P['炭灰']!] },
  { id: 'wallCabinet', name: '壁柜', cat: 'wall', w: 2, d: 0.35, h: 0.7, place: 'wall', wallY: 1.95, colors: CABINET },
  { id: 'rack', name: '壁挂架', cat: 'wall', w: 1, d: 0.15, h: 0.7, place: 'wall', wallY: 1.45, colors: [P['纯白']!, P['原木']!, P['樱花粉']!, P['薄荷']!, P['雾蓝']!] },
  { id: 'aircon', name: '空调', cat: 'wall', w: 1.5, d: 0.3, h: 0.45, place: 'wall', wallY: 2.25, colors: [P['纯白']!, P['奶油']!, P['浅灰']!, P['樱花粉']!] },
  { id: 'photos', name: '照片墙', cat: 'wall', w: 1.5, d: 0.05, h: 0.9, place: 'wall', wallY: 1.6, colors: [P['原木']!, P['樱花粉']!, P['雾蓝']!] },
];

/** 家具的编号：短一点，模型写方案时好照抄（同一间屋里不重复） */
export function newItemId(room?: Pick<DecorRoom, 'items'>): string {
  const bytes = new Uint8Array(4);
  for (;;) {
    crypto.getRandomValues(bytes);
    const id = `f${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
    if (!room?.items.some((i) => i.id === id)) return id;
  }
}

export function catalogItem(kind: string): CatalogItem | undefined {
  return CATALOG.find((c) => c.id === kind);
}

export const WALL_FINISHES: { id: string; name: string }[] = [
  { id: 'plain', name: '素色' },
  { id: 'stripe', name: '竖条纹' },
  { id: 'dots', name: '波点' },
  { id: 'check', name: '格纹' },
  { id: 'wainscot', name: '护墙板' },
  { id: 'brick', name: '砖墙' },
  { id: 'stars', name: '星星' },
];
export const FLOOR_FINISHES: { id: string; name: string }[] = [
  { id: 'wood', name: '木地板' },
  { id: 'herring', name: '人字拼' },
  { id: 'tile', name: '瓷砖' },
  { id: 'check', name: '棋盘格' },
  { id: 'carpet', name: '绒毯' },
  { id: 'terrazzo', name: '水磨石' },
];
export const ROOM_SIZES: { w: number; d: number; label: string }[] = [
  { w: 5, d: 4, label: '迷你' },
  { w: 6, d: 5, label: '小' },
  { w: 8, d: 7, label: '中' },
  { w: 10, d: 8, label: '大' },
];
export const WALL_H = 2.6;
export const TURN_LABELS = ['朝前', '朝右', '朝后', '朝左'] as const;
const EPS = 1e-6;

export function colorName(hex: string): string {
  const c = NAMED.find((p) => p.hex.toLowerCase() === hex.toLowerCase());
  return c?.name ?? hex;
}

/** 模型写的颜色：调色盘里的名字，或者 #rgb / #rrggbb */
export function parseColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const named = NAMED.find((p) => p.name === s) ?? NAMED.find((p) => s.includes(p.name));
  if (named) return named.hex;
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return null;
}

export function itemColor(item: Pick<DecorItem, 'kind' | 'color'>): string {
  return item.color ?? catalogItem(item.kind)?.colors[0] ?? '#cccccc';
}

// —— 占地 ——

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export function footprint(kind: string, turn: Turn): { w: number; d: number } {
  const c = catalogItem(kind);
  if (!c) return { w: 1, d: 1 };
  return turn % 2 ? { w: c.d, d: c.w } : { w: c.w, d: c.d };
}

export function rectOf(item: Pick<DecorItem, 'kind' | 'x' | 'z' | 'turn'>): Rect {
  const { w, d } = footprint(item.kind, item.turn);
  return { x0: item.x - w / 2, z0: item.z - d / 2, x1: item.x + w / 2, z1: item.z + d / 2 };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.z0 < b.z1 - EPS && b.z0 < a.z1 - EPS;
}

function inside(inner: Rect, outer: Rect): boolean {
  return inner.x0 >= outer.x0 - EPS && inner.x1 <= outer.x1 + EPS && inner.z0 >= outer.z0 - EPS && inner.z1 <= outer.z1 + EPS;
}

/** 占地的边对齐半格 */
export function snapCenter(v: number, size: number): number {
  return Math.round((v - size / 2) * 2) / 2 + size / 2;
}

/** 挂墙的东西沿墙的位置、高度 */
function wallRect(item: DecorItem): Rect {
  const c = catalogItem(item.kind);
  const w = c?.w ?? 1;
  const h = c?.h ?? 1;
  const along = item.wall === 'left' ? item.z : item.x;
  const y = item.y ?? c?.wallY ?? 1.4;
  return { x0: along - w / 2, x1: along + w / 2, z0: y - h / 2, z1: y + h / 2 };
}

/** 挡路的：地上的家具（不算地毯），和直接放在地上的小东西 */
export function blocks(room: DecorRoom, item: DecorItem): boolean {
  const c = catalogItem(item.kind);
  if (!c) return false;
  if (c.place === 'floor') return true;
  return c.place === 'top' && !item.on;
}

/** 这块地方下面能托住小东西的家具（台面盖得住这一块） */
export function supportUnder(room: DecorRoom, r: Rect, ignore: Set<string>): DecorItem | undefined {
  let best: DecorItem | undefined;
  for (const it of room.items) {
    if (ignore.has(it.id)) continue;
    const c = catalogItem(it.kind);
    if (!c?.top || it.on) continue;
    if (inside(r, rectOf(it)) && (!best || (catalogItem(best.kind)?.top ?? 0) < c.top)) best = it;
  }
  return best;
}

export interface PlaceCheck {
  ok: boolean;
  /** 台面上的东西：放在哪件上 */
  on?: string;
  reason?: string;
}

/** 这件东西放在这儿行不行（ignore：一起在挪的，比如桌子和桌上的东西） */
export function checkPlace(room: DecorRoom, item: DecorItem, ignore: Set<string> = new Set([item.id])): PlaceCheck {
  const c = catalogItem(item.kind);
  if (!c) return { ok: false, reason: '没有这件家具' };
  if (c.place === 'wall') {
    const r = wallRect(item);
    const len = item.wall === 'left' ? room.d : room.w;
    if (r.x0 < -EPS || r.x1 > len + EPS || r.z0 < 0.05 || r.z1 > WALL_H - 0.02) return { ok: false, reason: '超出墙面了' };
    for (const o of room.items) {
      if (ignore.has(o.id) || catalogItem(o.kind)?.place !== 'wall' || o.wall !== item.wall) continue;
      if (overlaps(r, wallRect(o))) return { ok: false, reason: '和墙上的东西挤在一起了' };
    }
    return { ok: true };
  }
  const r = rectOf(item);
  if (r.x0 < -EPS || r.z0 < -EPS || r.x1 > room.w + EPS || r.z1 > room.d + EPS) return { ok: false, reason: '超出屋子了' };
  if (c.place === 'rug') return { ok: true };
  if (c.place === 'top') {
    const sup = supportUnder(room, r, ignore);
    if (sup) {
      for (const o of room.items) {
        if (ignore.has(o.id) || o.on !== sup.id) continue;
        if (overlaps(r, rectOf(o))) return { ok: false, reason: '台面上放不下了' };
      }
      return { ok: true, on: sup.id };
    }
  }
  for (const o of room.items) {
    if (ignore.has(o.id) || !blocks(room, o)) continue;
    if (overlaps(r, rectOf(o))) {
      // 小东西放进桌子的范围里但台面盖不住：说清楚
      return { ok: false, reason: `和${catalogItem(o.kind)?.name ?? '别的家具'}挤在一起了` };
    }
  }
  return { ok: true };
}

/** 放在某件家具上的东西 */
export function childrenOf(room: DecorRoom, id: string): DecorItem[] {
  return room.items.filter((i) => i.on === id);
}

function rotate(dx: number, dz: number, quarter: number): [number, number] {
  const q = ((quarter % 4) + 4) % 4;
  // 朝向 +1 是从 +z 转到 +x（俯视逆时针看是顺时针）：(dx, dz) → (dz, -dx)
  let x = dx;
  let z = dz;
  for (let i = 0; i < q; i += 1) [x, z] = [z, -x];
  return [x, z];
}

/** 家具自己的坐标（朝前时）→ 屋里的坐标 */
export function localToRoom(item: Pick<DecorItem, 'x' | 'z' | 'turn'>, lx: number, lz: number): [number, number] {
  const [dx, dz] = rotate(lx, lz, item.turn);
  return [item.x + dx, item.z + dz];
}

/**
 * 挪 / 转一件家具（台面上的东西跟着）。返回新的屋子；放不下时返回原因。
 * 挂墙的东西：x / z 是沿墙位置，y 是高度，wall 可以换墙。
 */
export function moveItem(
  room: DecorRoom,
  id: string,
  to: { x: number; z: number; turn?: Turn; y?: number; wall?: WallSide },
): { ok: true; room: DecorRoom } | { ok: false; reason: string } {
  const item = room.items.find((i) => i.id === id);
  if (!item) return { ok: false, reason: '找不到这件家具' };
  const turn = to.turn ?? item.turn;
  const moved: DecorItem = { ...item, x: to.x, z: to.z, turn };
  if (to.y !== undefined) moved.y = to.y;
  if (to.wall) moved.wall = to.wall;
  const kids = childrenOf(room, id);
  const ignore = new Set([id, ...kids.map((k) => k.id)]);
  const check = checkPlace(room, moved, ignore);
  if (!check.ok) return { ok: false, reason: check.reason ?? '放不下' };
  if (catalogItem(moved.kind)?.place === 'top') {
    if (check.on) moved.on = check.on;
    else delete moved.on;
  }
  const dq = turn - item.turn;
  const movedKids = kids.map((k) => {
    const [dx, dz] = rotate(k.x - item.x, k.z - item.z, dq);
    return { ...k, x: moved.x + dx, z: moved.z + dz, turn: (((k.turn + dq) % 4) + 4) % 4 as Turn };
  });
  const byId = new Map([moved, ...movedKids].map((i) => [i.id, i]));
  return { ok: true, room: { ...room, items: room.items.map((i) => byId.get(i.id) ?? i) } };
}

/** 收起一件（台面上的东西一起收） */
export function removeItem(room: DecorRoom, id: string): DecorRoom {
  const gone = new Set([id, ...childrenOf(room, id).map((k) => k.id)]);
  return { ...room, items: room.items.filter((i) => !gone.has(i.id)) };
}

/** 复制一件：在旁边找个空地 */
export function duplicateItem(room: DecorRoom, id: string, by: 'you' | 'her' = 'you'): { room: DecorRoom; item: DecorItem } | null {
  const src = room.items.find((i) => i.id === id);
  if (!src) return null;
  return addItem(room, src.kind, { near: { x: src.x + 0.5, z: src.z + 0.5 }, turn: src.turn, color: src.color, wall: src.wall, by });
}

/**
 * 摆一件新的：在想要的位置附近找最近的空地（台面上的小东西优先找台面）。找不到时返回 null。
 * near 是屋里的坐标；挂墙的东西 near.x 是沿墙位置。
 */
export function addItem(
  room: DecorRoom,
  kind: string,
  opts: { near?: { x: number; z: number }; turn?: Turn; color?: string; wall?: WallSide; y?: number; on?: string; by?: 'you' | 'her' } = {},
): { room: DecorRoom; item: DecorItem } | null {
  const c = catalogItem(kind);
  if (!c) return null;
  const base: DecorItem = { id: newItemId(room), kind, x: 0, z: 0, turn: opts.turn ?? 0, ...(opts.color ? { color: opts.color } : {}), ...(opts.by ? { by: opts.by } : {}) };
  const tryAt = (cand: DecorItem): DecorItem | null => {
    const check = checkPlace(room, cand);
    if (!check.ok) return null;
    return check.on ? { ...cand, on: check.on } : cand;
  };
  if (c.place === 'wall') {
    const walls: WallSide[] = opts.wall ? [opts.wall, opts.wall === 'back' ? 'left' : 'back'] : ['back', 'left'];
    const y = opts.y ?? c.wallY ?? 1.4;
    for (const wall of walls) {
      const len = wall === 'left' ? room.d : room.w;
      const want = opts.near ? (wall === 'left' ? opts.near.z : opts.near.x) : len / 2;
      for (const along of spiral1d(want, c.w / 2, len - c.w / 2)) {
        for (const yy of [y, y + 0.4, y - 0.4]) {
          const cand = { ...base, wall, y: yy, turn: 0 as Turn, x: wall === 'back' ? along : 0, z: wall === 'left' ? along : 0 };
          const ok = tryAt(cand);
          if (ok) return { room: { ...room, items: [...room.items, ok] }, item: ok };
        }
      }
    }
    return null;
  }
  // 小东西：说了放在哪件家具上就先在那件的台面上找
  if (c.place === 'top') {
    const rank = (s: DecorItem) => {
      const i = c.prefer?.indexOf(s.kind) ?? -1;
      return i < 0 ? 99 : i;
    };
    const supports = room.items.filter((i) => !i.on && catalogItem(i.kind)?.top).sort((a, b) => rank(a) - rank(b));
    const preferred = opts.on ? supports.filter((s) => s.id === opts.on) : [];
    const order = [...preferred, ...(opts.near ? [] : supports.filter((s) => !preferred.includes(s)))];
    for (const s of order) {
      const r = rectOf(s);
      // 没说朝向就跟着下面那件（电视放在转过的电视柜上，也跟着转）
      const turn = opts.turn ?? s.turn;
      const { w, d } = footprint(kind, turn);
      for (let x = r.x0 + w / 2; x <= r.x1 - w / 2 + EPS; x += 0.5) {
        for (let z = r.z0 + d / 2; z <= r.z1 - d / 2 + EPS; z += 0.5) {
          const ok = tryAt({ ...base, turn, x, z });
          if (ok?.on) return { room: { ...room, items: [...room.items, ok] }, item: ok };
        }
      }
    }
  }
  // 床、柜子这类：没说放哪儿就靠着后墙（朝前）或者左墙（朝右）放，越靠墙中间越好
  if (c.hug && !opts.near) {
    const cands: [number, number, Turn, number][] = [];
    for (const turn of [0, 1] as Turn[]) {
      const { w, d } = footprint(kind, turn);
      if (turn === 0) for (let x = w / 2; x <= room.w - w / 2 + EPS; x += 0.5) cands.push([x, d / 2, 0, Math.abs(x - room.w / 2)]);
      else for (let z = d / 2; z <= room.d - d / 2 + EPS; z += 0.5) cands.push([w / 2, z, 1, Math.abs(z - room.d / 2) + 0.25]);
    }
    cands.sort((a, b) => a[3] - b[3]);
    for (const [x, z, turn] of cands) {
      const ok = tryAt({ ...base, turn, x, z });
      if (ok) return { room: { ...room, items: [...room.items, ok] }, item: ok };
    }
  }
  const turns: Turn[] = opts.turn !== undefined ? [opts.turn, ((opts.turn + 1) % 4) as Turn] : [0, 1];
  const want = opts.near ?? { x: room.w / 2, z: room.d / 2 + 0.5 };
  for (const turn of turns) {
    const { w, d } = footprint(kind, turn);
    for (const [x, z] of spiral2d(snapCenter(want.x, w), snapCenter(want.z, d), w, d, room)) {
      const ok = tryAt({ ...base, turn, x, z });
      if (ok) return { room: { ...room, items: [...room.items, ok] }, item: ok };
    }
  }
  return null;
}

function* spiral1d(center: number, min: number, max: number): Generator<number> {
  const c = Math.min(max, Math.max(min, Math.round(center * 4) / 4));
  for (let step = 0; step <= (max - min) * 4 + 1; step += 1) {
    for (const v of step ? [c + step * 0.25, c - step * 0.25] : [c]) if (v >= min - EPS && v <= max + EPS) yield v;
  }
}

function* spiral2d(cx: number, cz: number, w: number, d: number, room: DecorRoom): Generator<[number, number]> {
  const cands: [number, number, number][] = [];
  for (let x = w / 2; x <= room.w - w / 2 + EPS; x += 0.5) {
    for (let z = d / 2; z <= room.d - d / 2 + EPS; z += 0.5) cands.push([x, z, (x - cx) ** 2 + (z - cz) ** 2]);
  }
  cands.sort((a, b) => a[2] - b[2]);
  for (const [x, z] of cands) yield [x, z];
}

/** 换屋子大小：放不下的家具收起来（返回收起了几件） */
export function resizeRoom(room: DecorRoom, w: number, d: number): { room: DecorRoom; dropped: number } {
  let next: DecorRoom = { ...room, w, d, items: [] };
  let dropped = 0;
  // 先放地上的、再放台面上的
  const order = [...room.items].sort((a, b) => Number(!!a.on) - Number(!!b.on));
  for (const it of order) {
    if (it.on && !next.items.some((i) => i.id === it.on)) {
      dropped += 1;
      continue;
    }
    const check = checkPlace(next, it);
    if (check.ok) next = { ...next, items: [...next.items, it] };
    else dropped += 1;
  }
  return { room: next, dropped };
}

// —— 房间 ——

export interface RoomType {
  id: string;
  name: string;
  icon: string;
  w: number;
  d: number;
  wall: Finish;
  floor: Finish;
}

/** 房间的种类：前 6 种是一开始就有的；添房间时还能挑餐厅、空房间 */
export const ROOM_TYPES: RoomType[] = [
  { id: 'master', name: '主卧', icon: 'i-lucide-bed-double', w: 8, d: 7, wall: { finish: 'wainscot', color: P['奶油']! }, floor: { finish: 'herring', color: P['原木']! } },
  { id: 'second', name: '次卧', icon: 'i-lucide-bed-single', w: 6, d: 5, wall: { finish: 'dots', color: P['薄荷']! }, floor: { finish: 'wood', color: P['原木']! } },
  { id: 'living', name: '客厅', icon: 'i-lucide-sofa', w: 8, d: 7, wall: { finish: 'stripe', color: P['奶油']! }, floor: { finish: 'wood', color: P['原木']! } },
  { id: 'kitchen', name: '厨房', icon: 'i-lucide-cooking-pot', w: 6, d: 5, wall: { finish: 'check', color: P['鹅黄']! }, floor: { finish: 'tile', color: P['纯白']! } },
  { id: 'bath', name: '洗手间', icon: 'i-lucide-bath', w: 5, d: 4, wall: { finish: 'plain', color: P['雾蓝']! }, floor: { finish: 'check', color: P['浅灰']! } },
  { id: 'study', name: '书房', icon: 'i-lucide-book-open', w: 6, d: 5, wall: { finish: 'plain', color: P['抹茶']! }, floor: { finish: 'carpet', color: P['浅灰']! } },
  { id: 'dining', name: '餐厅', icon: 'i-lucide-utensils', w: 6, d: 5, wall: { finish: 'wainscot', color: P['蜜桃']! }, floor: { finish: 'herring', color: P['焦糖']! } },
  { id: 'blank', name: '空房间', icon: 'i-lucide-square-dashed', w: 6, d: 5, wall: { finish: 'plain', color: P['奶油']! }, floor: { finish: 'wood', color: P['原木']! } },
];
/** 一开始就有的 6 间，按这个顺序排 */
export const STARTER_ROOM_TYPES = ['master', 'second', 'living', 'kitchen', 'bath', 'study'];
export const MAX_ROOMS = 10;

export function roomType(id: string): RoomType {
  return ROOM_TYPES.find((t) => t.id === id) ?? ROOM_TYPES.at(-1)!;
}

function newRoomId(rooms: readonly Pick<DecorRoom, 'id'>[] = []): string {
  const bytes = new Uint8Array(4);
  for (;;) {
    crypto.getRandomValues(bytes);
    const id = `r${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
    if (!rooms.some((r) => r.id === id)) return id;
  }
}

/** 一间带几件家具的房间（位置写个大概，放不下的在附近找空地） */
export function starterRoom(typeId: string, rooms: readonly DecorRoom[] = []): DecorRoom {
  const t = roomType(typeId);
  // 同名的后面加个数：次卧、次卧 2……
  let name = t.name;
  for (let n = 2; rooms.some((r) => r.name === name); n += 1) name = `${t.name} ${n}`;
  let room: DecorRoom = { id: newRoomId(rooms), type: t.id, name, w: t.w, d: t.d, wall: { ...t.wall }, floor: { ...t.floor }, items: [] };
  /** 地上的：x、z、朝向；台面上的：on；墙上的：wall + 沿墙位置 */
  const put = (kind: string, x = 0, z = 0, turn?: Turn, extra: { on?: string; wall?: WallSide; y?: number; color?: string } = {}): string | undefined => {
    const res = addItem(room, kind, { ...(extra.on ? {} : { near: { x, z } }), ...(turn !== undefined ? { turn } : {}), ...extra });
    if (!res) return undefined;
    room = res.room;
    return res.item.id;
  };
  const top = (kind: string, on: string | undefined, color?: string) => (on ? put(kind, 0, 0, undefined, { on, color }) : undefined);
  const wall = (kind: string, side: WallSide, along: number, y?: number, color?: string) => put(kind, along, along, 0, { wall: side, y, color });

  if (t.id === 'living') {
    wall('window', 'back', 2.5);
    wall('painting', 'back', 5.5, 1.6);
    wall('aircon', 'back', 7);
    put('rugRound', 4, 3.5);
    put('sofa', 5, 1);
    put('plantTall', 0.5, 0.5);
    put('floorLamp', 7.5, 0.5);
    top('mug', put('coffee', 4.5, 3));
    top('tv', put('tvstand', 0.5, 3.5, 1));
  } else if (t.id === 'master') {
    wall('window', 'back', 1.5);
    wall('painting', 'back', 4, 1.75);
    wall('aircon', 'back', 6.75);
    put('rugRect', 4, 4.5, 0, { color: P['樱花粉'] });
    put('bed', 4, 1.5);
    top('deskLamp', put('nightstand', 2.5, 0.5));
    top('phone', put('nightstand', 5.5, 0.5));
    put('wardrobe', 0.5, 3.5, 1);
    top('vase', put('dresser', 7.5, 0.5));
  } else if (t.id === 'second') {
    wall('window', 'back', 4);
    wall('photos', 'left', 1.25);
    put('rugMat', 1.5, 2.5);
    put('bedsingle', 0.5, 1, 0, { color: P['雾蓝'] });
    top('candle', put('nightstand', 1.5, 0.5));
    const desk = put('desk', 4, 0.5);
    top('laptop', desk);
    top('deskLamp', desk);
    put('chair', 4, 1.5, 2);
    put('wardrobe', 0.5, 3.5, 1);
  } else if (t.id === 'kitchen') {
    wall('hood', 'back', 2);
    wall('wallCabinet', 'back', 4);
    wall('clock', 'back', 5.5);
    wall('rack', 'left', 2);
    wall('window', 'left', 4);
    put('fridge', 0.5, 0.5);
    top('cooker', put('stove', 2, 0.5));
    put('sink', 4, 0.5);
    const counter = put('counter', 0.5, 2, 1);
    top('microwave', counter);
    top('airfryer', counter);
    const table = put('dining', 3.5, 3.5);
    top('fruitBasket', table);
    top('bowls', table);
    top('plates', table);
    put('stool', 2, 3.5, 1);
    put('stool', 5, 3.5, 3);
  } else if (t.id === 'bath') {
    wall('mirror', 'back', 2.5);
    wall('towel', 'back', 4);
    wall('window', 'left', 3);
    put('bathtub', 1, 0.5, 1);
    put('washbasin', 2.5, 0.5);
    put('toilet', 4, 0.5);
    top('pot', put('washer', 0.5, 1.5, 1));
    put('rugMat', 2.5, 1.5, 0, { color: P['薄荷'] });
  } else if (t.id === 'study') {
    wall('window', 'back', 3);
    wall('clock', 'back', 5);
    wall('whiteboard', 'left', 4.25);
    put('rugRound', 4, 3.5, 0, { color: P['雾蓝'] });
    put('plantTall', 0.5, 0.5);
    const desk = put('desk', 3, 0.5);
    top('monitor', desk);
    top('deskLamp', desk);
    top('notepad', desk);
    top('penholder', desk);
    put('officeChair', 3, 1.5, 2);
    put('bookshelf', 0.5, 2.5, 1);
    top('printer', put('dresser', 5, 0.5));
    put('beanbag', 4.5, 3.5, 3);
  } else if (t.id === 'dining') {
    wall('window', 'back', 3);
    wall('painting', 'left', 2.5);
    put('rugRect', 3, 2.75);
    const table = put('diningLong', 3, 2.75);
    top('vase', table);
    top('plates', table);
    top('bowls', table);
    top('fruitBasket', table);
    put('chair', 2.25, 1.5, 0);
    put('chair', 3.75, 1.5, 0);
    put('chair', 2.25, 4, 2);
    put('chair', 3.75, 4, 2);
  } else {
    wall('window', 'back', room.w / 2);
  }
  return room;
}

/** 第一次来：6 个房间 */
export function starterRooms(): DecorRoom[] {
  const rooms: DecorRoom[] = [];
  for (const id of STARTER_ROOM_TYPES) rooms.push(starterRoom(id, rooms));
  return rooms;
}

/** 读存档：字段不对的丢掉 */
export function sanitizeRoom(v: unknown, rooms: readonly DecorRoom[] = []): DecorRoom | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<DecorRoom>;
  const size = ROOM_SIZES.find((s) => s.w === o.w && s.d === o.d) ?? ROOM_SIZES[2]!;
  const finish = (f: unknown, list: { id: string }[], fallback: Finish): Finish => {
    const x = f as Partial<Finish> | undefined;
    return { finish: list.some((l) => l.id === x?.finish) ? x!.finish! : fallback.finish, color: parseColor(x?.color) ?? fallback.color };
  };
  const items = Array.isArray(o.items)
    ? o.items.filter((i): i is DecorItem => !!i && typeof i.id === 'string' && !!catalogItem(i.kind) && Number.isFinite(i.x) && Number.isFinite(i.z) && [0, 1, 2, 3].includes(i.turn))
    : [];
  const type = ROOM_TYPES.find((t) => t.id === o.type)?.id ?? 'living';
  return {
    id: typeof o.id === 'string' && o.id && !rooms.some((r) => r.id === o.id) ? o.id : newRoomId(rooms),
    type,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 16) : roomType(type).name,
    w: size.w,
    d: size.d,
    wall: finish(o.wall, WALL_FINISHES, { finish: 'plain', color: '#f3e9d2' }),
    floor: finish(o.floor, FLOOR_FINISHES, { finish: 'wood', color: '#d2a679' }),
    items,
  };
}

/**
 * 读存档里的一套房间。老存档只有一间屋子（legacy）：把它当客厅，再补上另外 5 间。
 */
export function sanitizeRooms(list: unknown, legacy?: unknown): DecorRoom[] | null {
  if (Array.isArray(list)) {
    const rooms: DecorRoom[] = [];
    for (const v of list.slice(0, MAX_ROOMS)) {
      const r = sanitizeRoom(v, rooms);
      if (r) rooms.push(r);
    }
    return rooms.length ? rooms : null;
  }
  const old = sanitizeRoom(legacy);
  if (!old) return null;
  const rooms: DecorRoom[] = [];
  for (const id of STARTER_ROOM_TYPES) {
    if (id === 'living') rooms.push({ ...old, type: 'living', name: old.name === '我们的小屋' ? '客厅' : old.name });
    else rooms.push(starterRoom(id, rooms));
  }
  return rooms;
}

// —— 给模型看的 ——

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** 屋子现在的样子（编号、位置、朝向、颜色、谁放的） */
export function describeRoom(room: DecorRoom, names: { you: string; her: string }, rooms: readonly DecorRoom[] = [room]): string {
  const wallName = WALL_FINISHES.find((f) => f.id === room.wall.finish)?.name ?? room.wall.finish;
  const floorName = FLOOR_FINISHES.find((f) => f.id === room.floor.finish)?.name ?? room.floor.finish;
  const who = (i: DecorItem) => (i.by === 'her' ? `${names.her}放的` : i.by === 'you' ? `${names.you}放的` : '一开始就有');
  const line = (i: DecorItem) => {
    const c = catalogItem(i.kind)!;
    const where =
      c.place === 'wall'
        ? `${i.wall === 'left' ? '左墙' : '后墙'}上，沿墙 ${fmt(i.wall === 'left' ? i.z : i.x)}，离地 ${fmt(i.y ?? c.wallY ?? 1.4)}`
        : i.on
          ? `放在 ${i.on}（${catalogItem(room.items.find((s) => s.id === i.on)?.kind ?? '')?.name ?? ''}）上`
          : `在 (${fmt(i.x)}, ${fmt(i.z)})${c.place === 'rug' ? '' : `，${TURN_LABELS[i.turn]}`}`;
    return `${i.id} ${c.name}：${where}，${colorName(itemColor(i))}，${who(i)}`;
  };
  return [
    rooms.length > 1 ? `这套小屋一共 ${rooms.length} 个房间：${rooms.map((r) => `${r.name}（${r.items.length} 件）`).join('、')}。现在在「${room.name}」，下面说的、能改的都是这一间` : '',
    `房间「${room.name}」：地面 ${room.w} × ${room.d} 格（x 从左墙往右 0–${room.w}，z 从后墙往前 0–${room.d}；后墙在 z = 0，左墙在 x = 0，墙高 ${WALL_H}）`,
    `墙：${colorName(room.wall.color)} · ${wallName}；地面：${colorName(room.floor.color)} · ${floorName}`,
    room.items.length ? `现在摆着（编号 名字：位置，颜色，谁放的）：\n${room.items.map(line).join('\n')}` : '现在还是空的',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 能摆的家具（给模型挑） */
export function describeCatalog(): string {
  const place = (c: CatalogItem) =>
    c.place === 'wall' ? `挂墙，宽 ${c.w} 高 ${c.h}` : c.place === 'top' ? `小东西，${c.w} × ${c.d}，能放在桌台上` : c.place === 'rug' ? `地毯，${c.w} × ${c.d}` : `${c.w} × ${c.d}${c.top ? `，台面高 ${c.top} 能放小东西` : ''}${c.seats ? '，能坐' : ''}${c.beds ? '，能躺' : ''}`;
  return CATEGORIES.map((cat) => `${cat.label}：${CATALOG.filter((c) => c.cat === cat.id).map((c) => `${c.id}（${c.name}，${place(c)}）`).join('；')}`).join('\n');
}

// —— 她的布置方案 ——

export type PlanAction =
  | { do: 'add'; item: string; x?: number; z?: number; turn?: Turn; color?: string; wall?: WallSide; y?: number; on?: string }
  | { do: 'move'; id: string; x?: number; z?: number; turn?: Turn; wall?: WallSide; y?: number }
  | { do: 'turn'; id: string; turn: Turn }
  | { do: 'color'; id: string; color: string }
  | { do: 'remove'; id: string }
  | { do: 'wall' | 'floor'; finish?: string; color?: string };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const turnOf = (v: unknown): Turn | undefined => {
  const n = num(v);
  if (n !== undefined) return ((((Math.round(n) % 4) + 4) % 4) as Turn);
  const i = TURN_LABELS.findIndex((t) => t === v);
  return i >= 0 ? (i as Turn) : undefined;
};
const wallOf = (v: unknown): WallSide | undefined => (v === 'left' || v === '左墙' ? 'left' : v === 'back' || v === '后墙' ? 'back' : undefined);

export function parsePlanActions(v: unknown, max = 8): PlanAction[] {
  if (!Array.isArray(v)) return [];
  const out: PlanAction[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const op = String(o.do ?? o.op ?? '').trim();
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (op === 'add') {
      const kind = String(o.item ?? o.kind ?? '').trim();
      const c = CATALOG.find((x) => x.id === kind || x.name === kind);
      if (!c) continue;
      const a: PlanAction = { do: 'add', item: c.id };
      const x = num(o.x);
      const z = num(o.z);
      if (x !== undefined) a.x = x;
      if (z !== undefined) a.z = z;
      const t = turnOf(o.turn);
      if (t !== undefined) a.turn = t;
      const color = parseColor(o.color);
      if (color) a.color = color;
      const wall = wallOf(o.wall);
      if (wall) a.wall = wall;
      const y = num(o.y);
      if (y !== undefined) a.y = y;
      if (typeof o.on === 'string' && o.on.trim()) a.on = o.on.trim();
      out.push(a);
    } else if (op === 'move' && id) {
      const x = num(o.x);
      const z = num(o.z);
      const t = turnOf(o.turn);
      if (x === undefined && z === undefined && t === undefined) continue;
      const a: PlanAction = { do: 'move', id };
      if (x !== undefined) a.x = x;
      if (z !== undefined) a.z = z;
      if (t !== undefined) a.turn = t;
      const wall = wallOf(o.wall);
      if (wall) a.wall = wall;
      const y = num(o.y);
      if (y !== undefined) a.y = y;
      out.push(a);
    } else if (op === 'turn' && id) {
      const t = turnOf(o.turn);
      if (t !== undefined) out.push({ do: 'turn', id, turn: t });
    } else if (op === 'color' && id) {
      const color = parseColor(o.color);
      if (color) out.push({ do: 'color', id, color });
    } else if (op === 'remove' && id) {
      out.push({ do: 'remove', id });
    } else if (op === 'wall' || op === 'floor') {
      const list = op === 'wall' ? WALL_FINISHES : FLOOR_FINISHES;
      const f = list.find((x) => x.id === o.finish || x.name === o.finish);
      const color = parseColor(o.color);
      if (f || color) out.push({ do: op, ...(f ? { finish: f.id } : {}), ...(color ? { color } : {}) });
    }
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 照她的方案一步步改；放不下的跳过（找附近的空地，实在没有就算了）。
 * 返回改好的屋子、做成了的几步（中文，存进聊天）、新放的家具 id（画面上一件件冒出来）。
 */
export function applyPlan(room: DecorRoom, actions: PlanAction[]): { room: DecorRoom; done: string[]; skipped: string[]; added: string[]; touched: string[] } {
  let r = room;
  const done: string[] = [];
  const skipped: string[] = [];
  const added: string[] = [];
  const touched: string[] = [];
  const nameOf = (id: string) => catalogItem(r.items.find((i) => i.id === id)?.kind ?? '')?.name ?? id;
  for (const a of actions) {
    if (a.do === 'add') {
      const c = catalogItem(a.item)!;
      let near: { x: number; z: number } | undefined;
      if (c.place === 'wall') {
        // 沿墙位置：后墙写 x、左墙写 z（写反了也认）
        const along = a.wall === 'left' ? (a.z ?? a.x) : (a.x ?? a.z);
        if (along !== undefined) near = { x: along, z: along };
      } else if (a.x !== undefined || a.z !== undefined) near = { x: a.x ?? r.w / 2, z: a.z ?? r.d / 2 };
      const res = addItem(r, a.item, { near, turn: a.turn, color: a.color, wall: a.wall, y: a.y, on: a.on, by: 'her' });
      if (res) {
        r = res.room;
        added.push(res.item.id);
        done.push(`添了${a.color ? colorName(a.color) : ''}${c.name}`);
      } else skipped.push(`${c.name}放不下`);
    } else if (a.do === 'move' || a.do === 'turn') {
      const it = r.items.find((i) => i.id === a.id);
      if (!it) continue;
      const c = catalogItem(it.kind)!;
      let to: { x: number; z: number; turn?: Turn; wall?: WallSide; y?: number };
      if (a.do === 'turn') to = { x: it.x, z: it.z, turn: a.turn };
      else if (c.place === 'wall') {
        const wall = a.wall ?? it.wall ?? 'back';
        const along = (wall === 'left' ? (a.z ?? a.x) : (a.x ?? a.z)) ?? (wall === 'left' ? it.z : it.x);
        to = { x: wall === 'left' ? 0 : along, z: wall === 'left' ? along : 0, wall, y: a.y ?? it.y };
      } else {
        const turn = a.turn ?? it.turn;
        const { w, d } = footprint(it.kind, turn);
        to = { x: snapCenter(a.x ?? it.x, w), z: snapCenter(a.z ?? it.z, d), turn };
      }
      const res = moveItem(r, a.id, to);
      if (res.ok) {
        r = res.room;
        touched.push(a.id);
        done.push(a.do === 'turn' ? `把${c.name}转了个方向` : `挪了${c.name}`);
      } else skipped.push(`${c.name}挪不过去（${res.reason}）`);
    } else if (a.do === 'color') {
      if (!r.items.some((i) => i.id === a.id)) continue;
      const name = nameOf(a.id);
      r = { ...r, items: r.items.map((i) => (i.id === a.id ? { ...i, color: a.color } : i)) };
      touched.push(a.id);
      done.push(`把${name}换成了${colorName(a.color)}`);
    } else if (a.do === 'remove') {
      if (!r.items.some((i) => i.id === a.id)) continue;
      const name = nameOf(a.id);
      r = removeItem(r, a.id);
      done.push(`收起了${name}`);
    } else {
      const key = a.do;
      const cur = r[key];
      const next = { finish: a.finish ?? cur.finish, color: a.color ?? cur.color };
      r = { ...r, [key]: next };
      const list = key === 'wall' ? WALL_FINISHES : FLOOR_FINISHES;
      done.push(`把${key === 'wall' ? '墙' : '地面'}换成了${colorName(next.color)}${list.find((f) => f.id === next.finish)?.name ?? ''}`);
    }
  }
  return { room: r, done, skipped, added, touched };
}

/** 转 90°：原地转不开时在旁边找个能放下的位置 */
export function turnItem(room: DecorRoom, id: string): { ok: true; room: DecorRoom } | { ok: false; reason: string } {
  const item = room.items.find((i) => i.id === id);
  if (!item) return { ok: false, reason: '找不到这件家具' };
  if (catalogItem(item.kind)?.place === 'wall') return { ok: false, reason: '挂在墙上的不能转' };
  const turn = ((item.turn + 1) % 4) as Turn;
  const { w, d } = footprint(item.kind, turn);
  const cx = snapCenter(item.x, w);
  const cz = snapCenter(item.z, d);
  let reason = '';
  const offsets: [number, number][] = [[0, 0]];
  for (const r of [0.5, 1]) for (const [a, b] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]] as [number, number][]) offsets.push([a, b]);
  for (const [dx, dz] of offsets) {
    const res = moveItem(room, id, { x: cx + dx, z: cz + dz, turn });
    if (res.ok) return res;
    reason ||= res.reason;
  }
  return { ok: false, reason: reason || '转不开' };
}
