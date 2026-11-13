import { SCENES, type SceneId } from './scenes.ts';
import type { LocationActivity, LocationArea, MapLocation, MapShape, World } from './locations.ts';
import type { DayOutfit, OutfitItem, OutfitKind, RhythmDay, RhythmMeals, RhythmPerson, RhythmSettings, RhythmSlot, RhythmTemplate } from './types/rhythm.ts';
import { shiftDate, zonedDateKey, zonedParts } from './timezone.ts';

/**
 * 节律的算法部分（设计文档 §9 开头）：节律日、作息检查和兜底、读「节律」写回来的 JSON、把"建世界"的结果排成一张小地图。
 * 提示词在节律预设里（apps/web/src/presets/rhythm.json），这里只有协议和算法。
 */

/** 节律日从凌晨 4 点算起：4 点前还算前一天（熬夜到两点，她的"今天"还没过完） */
export const RHYTHM_DAY_START_HOUR = 4;

const pad = (n: number) => String(n).padStart(2, '0');

/** 用日历日期判断 4 点边界，夏令时切换日也不会提前或推迟一小时。 */
export function rhythmDate(now: Date, timeZone?: string): string {
  const date = timeZone ? zonedDateKey(now.getTime(), timeZone)
    : `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hour = timeZone ? zonedParts(now.getTime(), timeZone).hour : now.getHours();
  return hour < RHYTHM_DAY_START_HOUR ? shiftDate(date, -1) : date;
}

/** "07:30" → 450；"24:00" → 1440；写错了返回 null */
export function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

export function toHHMM(min: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** 作息里此刻那一段（按你的时间） */
export function slotIn<T extends { from: string; to: string }>(schedule: T[], now: Date): T | undefined {
  const t = now.getHours() * 60 + now.getMinutes();
  return schedule.find((s) => (toMinutes(s.from) ?? 0) <= t && t < (toMinutes(s.to) ?? 0)) ?? schedule.at(-1);
}

/** 这个场景该穿哪一套：运动穿运动的，哄睡、心跳穿睡衣，约会穿约会装（没有就日常），其余日常 */
export function outfitKindFor(sceneId: string | null | undefined): OutfitKind {
  if (sceneId === 'exercise') return 'sport';
  if (sceneId === 'sleep' || sceneId === 'heart') return 'sleep';
  if (sceneId === 'date') return 'date';
  return 'daily';
}

export function outfitOfDay(day: Pick<RhythmDay, 'outfits'> | null | undefined, sceneId: string | null | undefined): DayOutfit | undefined {
  if (!day) return undefined;
  const kind = outfitKindFor(sceneId);
  return day.outfits[kind] ?? day.outfits.daily;
}

// —— 模板 ——

let idSeq = 0;
function outfitId(): string {
  idSeq += 1;
  return `outfit-${Date.now().toString(36)}-${idSeq}`;
}

/** 演示角色：从她的世界（作息表、三餐、手头的事、衣柜）得到模板 */
export function templateFromWorld(world: World): RhythmTemplate {
  return {
    schedule: world.schedule.map((s) => ({ ...s })),
    meals: { ...world.life.meals },
    wardrobe: (world.life.wardrobe ?? []).map((o, i) => ({ ...o, id: `template:${world.id}:${i}` })),
    task: world.life.studyTask,
  };
}

/** 每种用途挑第一套（固定的时候用这几套） */
export function defaultOutfits(wardrobe: OutfitItem[]): Partial<Record<OutfitKind, DayOutfit>> {
  const out: Partial<Record<OutfitKind, DayOutfit>> = {};
  for (const o of wardrobe) out[o.kind] ??= { name: o.name, tags: o.tags };
  return out;
}

/** 按模板过一天（固定，或者「节律」没接通时） */
export function dayFromTemplate(characterId: string, date: string, template: RhythmTemplate): RhythmDay {
  return {
    characterId,
    date,
    schedule: template.schedule.map((s) => ({ ...s })),
    meals: { ...template.meals },
    outfits: defaultOutfits(template.wardrobe),
    task: template.task,
    events: [],
    source: 'template',
    at: Date.now(),
  };
}

// —— 检查和兜底：作息要盖满一整天、不重叠，地点都在她的世界里，固定的事没被挪 ——

interface Span {
  from: number;
  to: number;
  locationId: string;
  status: string;
  fixed?: boolean;
}

/** 模板在 [from, to) 里的那几段（切到这个范围） */
function templateSpans(template: RhythmTemplate, from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const s of template.schedule) {
    const a = toMinutes(s.from);
    const b = toMinutes(s.to);
    if (a === null || b === null) continue;
    const lo = Math.max(a, from);
    const hi = Math.min(b, to);
    if (hi > lo) out.push({ from: lo, to: hi, locationId: s.locationId, status: s.status, ...(s.fixed ? { fixed: true } : {}) });
  }
  return out;
}

export interface ScheduleCheck {
  schedule: RhythmSlot[];
  fixes: string[];
}

/**
 * 检查「节律」排的作息，不合格的部分用模板补：
 * - 时间写错、开始不早于结束的段去掉；
 * - 地点不在她的世界里：能按名字认出来就换成那个地点，认不出就用模板这个时间的地点；
 * - 模板里标了"固定"的事原样放回去（排的东西和它重叠的部分让出来）；
 * - 和前一段重叠的部分去掉；空着的时间用模板补上；
 * - 相邻两段一模一样的合成一段。
 */
export function checkSchedule(raw: RhythmSlot[], ctx: { template: RhythmTemplate; resolve(ref: string): string | null }): ScheduleCheck {
  const fixes: string[] = [];
  const spans: Span[] = [];
  for (const s of raw) {
    const a = toMinutes(s.from);
    const b = toMinutes(s.to);
    if (a === null || b === null || b <= a) {
      fixes.push(`去掉了写错的时间 ${s.from}–${s.to}`);
      continue;
    }
    let loc = ctx.resolve(s.locationId);
    if (!loc) {
      const t = templateSpans(ctx.template, a, a + 1)[0];
      loc = t?.locationId ?? ctx.template.schedule[0]?.locationId ?? '';
      fixes.push(`"${s.locationId}"不在她的世界里，${s.from}–${s.to} 改在模板的地点`);
    }
    if (!loc) continue;
    spans.push({ from: a, to: b, locationId: loc, status: s.status.trim() || '自己的事' });
  }
  spans.sort((x, y) => x.from - y.from);

  // 固定的事：按模板放回去
  const fixed = templateSpans(ctx.template, 0, 1440).filter((s) => s.fixed);
  let merged: Span[] = spans;
  for (const f of fixed) {
    const moved = !merged.some((s) => s.from === f.from && s.to === f.to && s.locationId === f.locationId);
    if (moved) fixes.push(`固定的事"${f.status}"（${toHHMM(f.from)}–${toHHMM(f.to)}）放回原处`);
    const next: Span[] = [];
    for (const s of merged) {
      if (s.to <= f.from || s.from >= f.to) next.push(s);
      else {
        if (s.from < f.from) next.push({ ...s, to: f.from });
        if (s.to > f.to) next.push({ ...s, from: f.to });
      }
    }
    next.push({ ...f });
    merged = next.sort((x, y) => x.from - y.from);
  }

  // 去重叠、补空当
  const out: Span[] = [];
  let cursor = 0;
  let overlapped = false;
  for (const s of merged) {
    let from = s.from;
    if (from < cursor) {
      overlapped = true;
      from = cursor;
    }
    if (s.to <= from) continue;
    if (from > cursor) {
      out.push(...templateSpans(ctx.template, cursor, from));
      fixes.push(`空着的 ${toHHMM(cursor)}–${toHHMM(from)} 按模板补上`);
    }
    out.push({ ...s, from });
    cursor = s.to;
  }
  if (cursor < 1440) {
    out.push(...templateSpans(ctx.template, cursor, 1440));
    if (merged.length) fixes.push(`空着的 ${toHHMM(cursor)}–24:00 按模板补上`);
  }
  if (overlapped) fixes.push('重叠的时间段去掉了后一段重叠的部分');

  // 模板自己也可能没盖满：还空着的时间放在第一个地点
  const filled: Span[] = [];
  cursor = 0;
  for (const s of out.sort((x, y) => x.from - y.from)) {
    if (s.from > cursor) filled.push({ from: cursor, to: s.from, locationId: s.locationId, status: '自己的事' });
    if (s.to > Math.max(cursor, s.from)) filled.push({ ...s, from: Math.max(cursor, s.from) });
    cursor = Math.max(cursor, s.to);
  }
  if (cursor < 1440 && filled.length) filled.push({ ...(filled.at(-1) as Span), from: cursor, to: 1440 });

  const schedule: RhythmSlot[] = [];
  for (const s of filled) {
    const prev = schedule.at(-1);
    if (prev && prev.locationId === s.locationId && prev.status === s.status && !!prev.fixed === !!s.fixed && prev.to === toHHMM(s.from)) {
      prev.to = toHHMM(s.to);
      continue;
    }
    schedule.push({ from: toHHMM(s.from), to: toHHMM(s.to), locationId: s.locationId, status: s.status, ...(s.fixed ? { fixed: true } : {}) });
  }
  return { schedule, fixes: [...new Set(fixes)] };
}

// —— 读「节律」写回来的 JSON ——

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const KINDS: OutfitKind[] = ['daily', 'sport', 'sleep', 'date'];

function slotsFrom(v: unknown): RhythmSlot[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((s) => ({
    from: str(s.from),
    to: str(s.to),
    locationId: str(s.at ?? s.location ?? s.locationId ?? s.place),
    status: str(s.status ?? s.doing ?? s.what),
    ...(s.fixed === true ? { fixed: true } : {}),
  }));
}

function mealsFrom(v: unknown): Partial<RhythmMeals> {
  if (!isObj(v)) return {};
  const out: Partial<RhythmMeals> = {};
  for (const k of ['breakfast', 'lunch', 'dinner'] as const) if (str(v[k])) out[k] = str(v[k]);
  return out;
}

function outfitFrom(v: unknown): DayOutfit | null {
  if (!isObj(v)) return null;
  const name = str(v.name);
  const tags = str(v.tags).replace(/[\r\n]+/g, ', ');
  return name || tags ? { name: name || tags.split(',')[0]?.trim() || '一套衣服', tags } : null;
}

export interface PlanDayOutput {
  schedule: RhythmSlot[];
  meals: Partial<RhythmMeals>;
  outfits: Partial<Record<OutfitKind, DayOutfit>>;
  task: string;
  events: string[];
}

/** Both the PWA and Worker apply the same variation switches and validation. */
export function rhythmDayFromPlan(input: {
  characterId: string; date: string; template: RhythmTemplate; settings: RhythmSettings;
  locations: MapLocation[]; output: PlanDayOutput; model: string; at: number;
}): RhythmDay {
  const { characterId, date, template, settings, output: out } = input;
  const vary = settings.mode === 'daily' ? settings.vary : { schedule: false, meals: false, outfits: false };
  const base = dayFromTemplate(characterId, date, template);
  const fixes: string[] = [];
  let schedule = base.schedule;
  if (vary.schedule && out.schedule.length) {
    const checked = checkSchedule(out.schedule, { template, resolve: locationResolver(input.locations, characterId) });
    schedule = checked.schedule;
    fixes.push(...checked.fixes);
  } else if (vary.schedule) fixes.push('没有排作息，按模板');
  const outfits = { ...base.outfits };
  if (vary.outfits) {
    for (const [kind, o] of Object.entries(out.outfits) as [OutfitKind, DayOutfit][]) if (o?.tags) outfits[kind] = o;
    if (settings.outfitMode === 'pick') {
      const fallback = defaultOutfits(template.wardrobe);
      for (const kind of Object.keys(outfits) as OutfitKind[]) {
        const o = outfits[kind];
        if (o && template.wardrobe.length && !template.wardrobe.some((w) => w.name === o.name || w.tags === o.tags)) {
          fixes.push(`"${o.name}"不在衣柜里，换成衣柜里的`);
          if (fallback[kind]) outfits[kind] = fallback[kind];
          else delete outfits[kind];
        }
      }
    }
  }
  return { characterId, date, schedule, meals: vary.meals ? { ...base.meals, ...out.meals } : base.meals,
    outfits, task: out.task || base.task, events: out.events, source: 'model', model: input.model, at: input.at,
    ...(fixes.length ? { fixes } : {}) };
}

/** "排今天"的输出；什么都没写时返回 null（让调用方按格式不对重试） */
export function parsePlanDay(value: unknown): PlanDayOutput | null {
  if (!isObj(value)) return null;
  const outfits: Partial<Record<OutfitKind, DayOutfit>> = {};
  if (isObj(value.outfits)) {
    for (const k of KINDS) {
      const o = outfitFrom(value.outfits[k]);
      if (o) outfits[k] = o;
    }
  }
  const out: PlanDayOutput = {
    schedule: slotsFrom(value.schedule),
    meals: mealsFrom(value.meals),
    outfits,
    task: str(value.task),
    events: Array.isArray(value.events) ? value.events.map(str).filter(Boolean).slice(0, 3) : [],
  };
  if (!out.schedule.length && !Object.keys(out.meals).length && !Object.keys(out.outfits).length && !out.task) return null;
  return out;
}

// —— 建世界 ——

/** 场景背景（占位背景按 key 画，以后换成真背景图也按 key） */
export const BACKDROPS = ['bedroom', 'library', 'dining', 'cafe', 'park', 'seaside', 'pool', 'gym', 'cinema', 'night-market', 'gallery', 'aquarium', 'amusement', 'music'] as const;
export type BackdropKey = (typeof BACKDROPS)[number];

const BACKDROP_ICON: Record<BackdropKey, string> = {
  bedroom: 'i-lucide-house',
  library: 'i-lucide-library-big',
  dining: 'i-lucide-utensils',
  cafe: 'i-lucide-coffee',
  park: 'i-lucide-trees',
  seaside: 'i-lucide-sailboat',
  pool: 'i-lucide-waves',
  gym: 'i-lucide-dumbbell',
  cinema: 'i-lucide-clapperboard',
  'night-market': 'i-lucide-lamp',
  gallery: 'i-lucide-frame',
  aquarium: 'i-lucide-fish',
  amusement: 'i-lucide-ferris-wheel',
  music: 'i-lucide-music',
};

export interface BuiltLocationSpec {
  key: string;
  name: string;
  area: Exclude<LocationArea, 'real'>;
  indoor: boolean;
  backdrop: BackdropKey;
  blurb: string;
  activities: LocationActivity[];
}

export interface BuiltWorldSpec {
  name: string;
  blurb: string;
  areas: Partial<Record<Exclude<LocationArea, 'real'>, string>>;
  homeKey: string;
  locations: BuiltLocationSpec[];
  people: RhythmPerson[];
  schedule: RhythmSlot[];
  meals: Partial<RhythmMeals>;
  wardrobe: Omit<OutfitItem, 'id'>[];
  task: string;
}

const AREAS = ['home', 'campus', 'city'] as const;
const SCENE_IDS = new Set<string>(SCENES.map((s) => s.id));

function keyFrom(raw: string, i: number): string {
  const k = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return k || `place-${i + 1}`;
}

/** "建世界"的输出：至少要有住处和一段作息；地点的背景、场景不认识的换成认识的 */
export function parseBuiltWorld(value: unknown): BuiltWorldSpec | null {
  if (!isObj(value) || !Array.isArray(value.locations)) return null;
  const seen = new Set<string>();
  const locations: BuiltLocationSpec[] = [];
  value.locations.filter(isObj).forEach((l, i) => {
    const name = str(l.name);
    if (!name) return;
    let key = keyFrom(str(l.key ?? l.id) || name, i);
    while (seen.has(key)) key = `${key}-${i + 1}`;
    seen.add(key);
    const area = AREAS.includes(l.area as (typeof AREAS)[number]) ? (l.area as BuiltLocationSpec['area']) : 'city';
    const activities = (Array.isArray(l.activities) ? l.activities : [])
      .map((a) => (isObj(a) ? { sceneId: str(a.scene ?? a.sceneId), label: str(a.label) } : { sceneId: str(a), label: '' }))
      // 共同的家、心跳不放在她世界的地点上（入口在地图"一起做点什么"里，一直都在）
      .filter((a) => SCENE_IDS.has(a.sceneId) && a.sceneId !== 'free' && a.sceneId !== 'home' && a.sceneId !== 'heart')
      .map((a) => ({ sceneId: a.sceneId as SceneId, label: a.label || (SCENES.find((s) => s.id === a.sceneId)?.name ?? a.sceneId) }));
    const backdrop = BACKDROPS.includes(l.backdrop as BackdropKey) ? (l.backdrop as BackdropKey) : guessBackdrop(area, activities);
    locations.push({ key, name: name.slice(0, 12), area, indoor: l.indoor !== false, backdrop, blurb: str(l.blurb).slice(0, 40), activities });
  });
  if (!locations.length) return null;
  const homeRaw = str(value.homeKey ?? value.home);
  const home = locations.find((l) => l.key === keyFrom(homeRaw, 0) || l.name === homeRaw) ?? locations.find((l) => l.area === 'home') ?? locations[0]!;
  home.area = 'home';
  // 住处总能哄睡、听歌、戳戳乐
  for (const sceneId of ['sleep', 'music', 'poke'] as SceneId[]) {
    if (!home.activities.some((a) => a.sceneId === sceneId)) home.activities.push({ sceneId, label: SCENES.find((s) => s.id === sceneId)?.name ?? sceneId });
  }
  const wardrobe = (Array.isArray(value.wardrobe) ? value.wardrobe : [])
    .filter(isObj)
    .map((o) => ({ kind: (KINDS.includes(o.kind as OutfitKind) ? o.kind : 'daily') as OutfitKind, name: str(o.name), tags: str(o.tags).replace(/[\r\n]+/g, ', ') }))
    .filter((o) => o.name || o.tags);
  const areas: BuiltWorldSpec['areas'] = {};
  if (isObj(value.areas)) for (const a of AREAS) if (str(value.areas[a])) areas[a] = str(value.areas[a]).slice(0, 8);
  return {
    name: str(value.name).slice(0, 20),
    blurb: str(value.blurb).slice(0, 60),
    areas,
    homeKey: home.key,
    locations,
    people: (Array.isArray(value.people) ? value.people : [])
      .filter(isObj)
      .map((p) => ({ name: str(p.name), relation: str(p.relation), note: str(p.note) }))
      .filter((p) => p.name)
      .slice(0, 12),
    schedule: slotsFrom(value.schedule),
    meals: mealsFrom(value.meals),
    wardrobe,
    task: str(value.task),
  };
}

/** 背景写得不认识时，按在那里能做的事猜一个 */
function guessBackdrop(area: BuiltLocationSpec['area'], activities: LocationActivity[]): BackdropKey {
  if (area === 'home') return 'bedroom';
  const has = (id: string) => activities.some((a) => a.sceneId === id);
  if (has('study') || has('read')) return 'library';
  if (has('meal')) return 'dining';
  if (has('exercise')) return 'park';
  if (has('watch')) return 'cinema';
  if (has('music')) return 'music';
  return 'cafe';
}

/** 生成的世界里地点的 id：角色 id/地点 key（和别的世界不会撞） */
export function builtLocationId(characterId: string, key: string): string {
  return `${characterId}/${key}`;
}

/** 片区在 400×300 底图上占的地方 */
const AREA_RECT: Record<Exclude<LocationArea, 'real'>, { x: number; y: number; w: number; h: number }> = {
  home: { x: 6, y: 6, w: 132, h: 118 },
  campus: { x: 164, y: 6, w: 230, h: 150 },
  city: { x: 6, y: 178, w: 388, h: 116 },
};
const AREA_DEFAULT_LABEL = { home: '住处', campus: '常去的地方', city: '城里' } as const;

/** 在一个矩形里按网格摆 n 个点（返回 0-100 的百分比坐标） */
function grid(n: number, r: { x: number; y: number; w: number; h: number }): { x: number; y: number }[] {
  if (!n) return [];
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * r.w) / r.h))));
  const rows = Math.ceil(n / cols);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i - row * cols;
    const cx = r.x + (r.w * (col + 0.5)) / inRow;
    const cy = r.y + (r.h * (row + 0.5)) / rows;
    out.push({ x: Math.round((cx / 400) * 1000) / 10, y: Math.round((cy / 300) * 1000) / 10 });
  }
  return out;
}

/** 底图：三个片区、两条路、一点水和绿地；地点上画个小房子 */
function baseShapes(used: Set<string>, pins: { x: number; y: number }[]): { base: MapShape[]; labels: World['labels'] } {
  const base: MapShape[] = [];
  if (used.has('home')) base.push({ kind: 'rect', cls: 'home', ...AREA_RECT.home, r: 18 } as MapShape);
  if (used.has('campus')) base.push({ kind: 'rect', cls: 'campus', ...AREA_RECT.campus, r: 18 } as MapShape);
  base.push({ kind: 'path', cls: 'park', d: 'M0 300 L0 246 C40 240 76 252 104 274 C114 284 118 292 120 300 Z' });
  base.push({ kind: 'path', cls: 'water', d: 'M300 300 C324 276 356 262 400 254 L400 300 Z' });
  base.push({ kind: 'path', cls: 'road', d: 'M0 166 H400 M150 0 V300' });
  base.push({ kind: 'path', cls: 'road-line', d: 'M0 166 H400 M150 0 V300' });
  for (const p of pins) {
    const x = (p.x / 100) * 400;
    const y = (p.y / 100) * 300;
    base.push({ kind: 'rect', cls: 'bldg', x: Math.round(x - 12), y: Math.round(y - 22), w: 24, h: 14, r: 3 });
  }
  return { base, labels: [] };
}

/** "建世界"的结果 → 她的世界（地点、底图、作息）、节律模板、身边的人 */
export function worldFromSpec(characterId: string, characterName: string, spec: BuiltWorldSpec): { world: World; template: RhythmTemplate; people: RhythmPerson[] } {
  const ids = new Map(spec.locations.map((l) => [l.key, builtLocationId(characterId, l.key)]));
  const pins = new Map<string, { x: number; y: number }>();
  for (const area of AREAS) {
    const inArea = spec.locations.filter((l) => l.area === area);
    const r = AREA_RECT[area];
    const pad = { x: r.x + 14, y: r.y + 16, w: r.w - 28, h: r.h - 30 };
    grid(inArea.length, pad).forEach((p, i) => pins.set(inArea[i]!.key, p));
  }
  const locations: MapLocation[] = spec.locations.map((l) => ({
    id: ids.get(l.key)!,
    name: l.name,
    area: l.area,
    icon: BACKDROP_ICON[l.backdrop],
    x: pins.get(l.key)?.x ?? 50,
    y: pins.get(l.key)?.y ?? 50,
    backdrop: l.backdrop,
    indoor: l.indoor,
    blurb: l.blurb,
    activities: l.activities,
  }));
  const used = new Set(spec.locations.map((l) => l.area));
  const { base } = baseShapes(used, [...pins.values()]);
  const areaLabels = {
    home: spec.areas.home || AREA_DEFAULT_LABEL.home,
    campus: spec.areas.campus || AREA_DEFAULT_LABEL.campus,
    city: spec.areas.city || AREA_DEFAULT_LABEL.city,
  };
  const labels: World['labels'] = [];
  if (used.has('home')) labels.push({ text: areaLabels.home, x: 16, y: 118 });
  if (used.has('campus')) labels.push({ text: areaLabels.campus, x: 174, y: 150 });
  if (used.has('city')) labels.push({ text: areaLabels.city, x: 300, y: 292 });

  const homeId = ids.get(spec.homeKey) ?? locations[0]!.id;
  const resolve = locationResolver(locations, characterId);
  const fallback: RhythmTemplate = {
    schedule: [
      { from: '00:00', to: '08:00', locationId: homeId, status: '睡觉中' },
      { from: '08:00', to: '22:30', locationId: homeId, status: '忙自己的事' },
      { from: '22:30', to: '24:00', locationId: homeId, status: '准备睡了' },
    ],
    meals: { breakfast: '', lunch: '', dinner: '' },
    wardrobe: [],
    task: '',
  };
  const { schedule } = checkSchedule(spec.schedule, { template: fallback, resolve });
  const template: RhythmTemplate = {
    schedule,
    meals: { breakfast: spec.meals.breakfast ?? '', lunch: spec.meals.lunch ?? '', dinner: spec.meals.dinner ?? '' },
    wardrobe: spec.wardrobe.map((o) => ({ ...o, id: outfitId() })),
    task: spec.task,
  };
  const world: World = {
    id: `world-${characterId}`,
    characterId,
    name: spec.name || `${characterName}的小世界`,
    blurb: spec.blurb,
    homeId,
    areaLabels,
    locations,
    base,
    labels,
    schedule: schedule.map(({ fixed: _f, ...s }) => s),
    life: { studyTask: template.task, meals: { ...template.meals }, wardrobe: spec.wardrobe },
  };
  return { world, template, people: spec.people };
}

/**
 * 认地点：完整 id → 生成的世界里"角色 id/key"的 key → 名字（完全一样，或者一个包含另一个）。
 * 「节律」排作息时可能写地点 id，也可能写名字
 */
export function locationResolver(locations: MapLocation[], characterId?: string): (ref: string) => string | null {
  return (ref: string) => {
    const r = ref.trim();
    if (!r) return null;
    const byId = locations.find((l) => l.id === r || (characterId && l.id === builtLocationId(characterId, r)));
    if (byId) return byId.id;
    const byName = locations.find((l) => l.name === r) ?? locations.find((l) => r.includes(l.name) || l.name.includes(r));
    return byName?.id ?? null;
  };
}
