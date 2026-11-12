import { buildRhythmMessages, errorReport, errorText, samplerRequest, type RhythmFill } from '@app/ai';
import {
  checkSchedule,
  dayFromTemplate,
  DEFAULT_RHYTHM_SETTINGS,
  defaultOutfits,
  getLocation,
  hasOwnWorld,
  locationResolver,
  OUTFIT_KINDS,
  outfitOfDay,
  parseBuiltWorld,
  parsePlanDay,
  registerWorld,
  rhythmDate,
  slotIn,
  solarTermNote,
  substituteMacros,
  templateFromWorld,
  unregisterWorld,
  worldFromSpec,
  worldOf,
  type Character,
  type CharacterRhythm,
  type DayOutfit,
  type OutfitKind,
  type RhythmDay,
  type RhythmMeals,
  type RhythmPerson,
  type RhythmSettings,
  type RhythmSlot,
  type RhythmTemplate,
  type World,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { useAiStore } from './ai';
import { useCharacterStore } from './characters';
import { useChatStore } from './chat';
import { useLibraryStore } from './library';
import { autoSave, getEntries, write } from '@/db/idb';
import { personas } from '@/mock/characters';
import { uid } from '@/utils/id';

/**
 * 节律（设计文档 §9 开头）：她每天的作息、三餐和穿着，都挂在角色 id 下，存在本机。
 * - 每个角色在"我的 → 节律"里选：固定（一直用模板）/ 每天变化（作息、三餐、穿着可以分别勾；穿着从衣柜挑或每天新编）；
 * - 模板：演示角色来自她的世界；导入的角色先"建世界"（「节律」从角色卡和世界书里生成她的地点、身边的人、作息模板、三餐、衣柜）；
 * - 每天：固定的直接按模板；每天变化的在当天第一次打开 App 时交给「节律」排（也可以手动"重新排今天"），
 *   排出来的先检查（盖满一整天、不重叠、地点在她的世界里、固定的事没挪），不合格的部分用模板补；
 * - 用在：她此刻在哪、在做什么（每分钟按今天的作息更新）；陪伴学习里她的小目标；一起吃饭她吃什么；
 *   生图这个场景该穿哪套（同一天的图衣服一致）；【当前环境】里她今天穿什么。
 * 节律日从凌晨 4 点算起。云端（Worker）凌晨排今天还没做，现在是打开 App 时在本机排。
 */

export type RhythmResult<T> = { ok: true; value: T } | { ok: false; reason: string; detail?: string; notConnected?: boolean };

/** "建世界"的结果：先给你看，确认后才存 */
export interface WorldPreview {
  world: World;
  template: RhythmTemplate;
  people: RhythmPerson[];
  model: string;
}

const DAY = 86_400_000;
const KEEP_DAYS = 30;

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function dayKey(characterId: string, date: string) {
  return `${characterId}:${date}`;
}

/** 最近 n 个节律日（不含今天），从近到远 */
function previousDates(today: string, n: number): string[] {
  const base = new Date(`${today}T12:00:00`);
  return Array.from({ length: n }, (_, i) => rhythmDate(new Date(base.getTime() - (i + 1) * DAY + 4 * 3_600_000)));
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const useRhythmStore = defineStore('rhythm', () => {
  const configs = reactive<Record<string, CharacterRhythm>>({});
  const days = reactive<Record<string, RhythmDay>>({});
  /** 导入的角色"建世界"后生成的世界（同时登记进 @app/shared，地图、场景、提示词都认得） */
  const worlds = reactive<Record<string, World>>({});
  /** 正在排 / 正在建的角色 */
  const busy = reactive<Record<string, 'plan' | 'build' | undefined>>({});
  /** 最近一次排今天失败的原因（只在内存里）；节律页显示 */
  const errors = reactive<Record<string, { at: number; reason: string; detail?: string } | undefined>>({});
  /** 今天是哪个节律日（每分钟更新） */
  const today = ref(rhythmDate(new Date()));

  const saver = autoSave(
    'rhythm',
    () => [
      ...Object.values(configs).map((c) => ({ key: `char:${c.characterId}`, value: c })),
      ...Object.values(days).map((d) => ({ key: `day:${dayKey(d.characterId, d.date)}`, value: d })),
      ...Object.values(worlds).map((w) => ({ key: `world:${w.characterId}`, value: w })),
    ],
    () => [configs, days, worlds],
  );

  async function hydrate() {
    const entries = await getEntries<unknown>('rhythm');
    const oldest = rhythmDate(new Date(Date.now() - KEEP_DAYS * DAY));
    const stale: string[] = [];
    for (const { key, value } of entries) {
      if (!value || typeof value !== 'object') continue;
      if (key.startsWith('char:')) {
        const c = value as CharacterRhythm;
        configs[c.characterId] = { ...c, settings: { ...DEFAULT_RHYTHM_SETTINGS, ...c.settings, vary: { ...DEFAULT_RHYTHM_SETTINGS.vary, ...c.settings?.vary } }, people: c.people ?? [] };
      } else if (key.startsWith('day:')) {
        const d = value as RhythmDay;
        if (d.date < oldest) stale.push(key);
        else days[dayKey(d.characterId, d.date)] = d;
      } else if (key.startsWith('world:')) {
        const w = value as World;
        worlds[w.characterId] = w;
        registerWorld(w);
      }
    }
    if (stale.length) await write('rhythm', [], stale);
    saver.start();
  }

  // —— 读 ——

  /** 这个角色的节律设置（还没设置过时是默认：固定） */
  function configOf(characterId: string): CharacterRhythm {
    return configs[characterId] ?? { characterId, settings: clone(DEFAULT_RHYTHM_SETTINGS), template: null, people: [], updatedAt: 0 };
  }

  /** 要改设置时先放进表里 */
  function ensureConfig(characterId: string): CharacterRhythm {
    if (!configs[characterId]) configs[characterId] = configOf(characterId);
    return configs[characterId] as CharacterRhythm;
  }

  /** 她有没有自己的世界（演示角色有；导入的角色"建世界"以后才有） */
  function hasWorld(characterId: string): boolean {
    return !!worlds[characterId] || hasOwnWorld(characterId);
  }

  /** 她的模板：自己改过 / 建世界生成的；演示角色还没改过时来自她的世界；导入的角色没建世界时为空 */
  function templateOf(characterId: string): RhythmTemplate | null {
    const own = configs[characterId]?.template;
    if (own) return own;
    return hasWorld(characterId) ? templateFromWorld(worldOf(characterId)) : null;
  }

  /** 某一天：存下来的（排过的、改过的），否则按模板 */
  function dayOf(characterId: string, date = today.value): RhythmDay | null {
    const saved = days[dayKey(characterId, date)];
    if (saved) return saved;
    const t = templateOf(characterId);
    return t ? dayFromTemplate(characterId, date, t) : null;
  }

  function todayOf(characterId: string): RhythmDay | null {
    return dayOf(characterId, today.value);
  }

  /** 最近 n 天排过的（不含今天），从近到远 */
  function recentDays(characterId: string, n = 7): RhythmDay[] {
    return previousDates(today.value, n)
      .map((d) => days[dayKey(characterId, d)])
      .filter((d): d is RhythmDay => !!d);
  }

  /** 这个场景她今天该穿的那套（生图用）；没有节律时为空 */
  function outfitFor(characterId: string, sceneId: string | null | undefined): DayOutfit | undefined {
    return outfitOfDay(todayOf(characterId), sceneId);
  }

  /** 她今天手头的事（陪伴学习里她的小目标） */
  function taskOf(characterId: string): string {
    return todayOf(characterId)?.task || (hasWorld(characterId) ? worldOf(characterId).life.studyTask : '');
  }

  function mealsOf(characterId: string): RhythmMeals | null {
    return todayOf(characterId)?.meals ?? null;
  }

  /** 她此刻按今天的作息在哪、在做什么 */
  function slotNow(characterId: string, now = new Date()): RhythmSlot | undefined {
    const d = todayOf(characterId);
    return d?.schedule.length ? slotIn(d.schedule, now) : undefined;
  }

  // —— 改 ——

  function setSettings(characterId: string, patch: Partial<RhythmSettings>) {
    const c = ensureConfig(characterId);
    c.settings = { ...c.settings, ...patch, vary: { ...c.settings.vary, ...patch.vary } };
    c.updatedAt = Date.now();
  }

  /** 改模板（第一次改时从她的世界复制一份出来） */
  function editTemplate(characterId: string): RhythmTemplate | null {
    const c = ensureConfig(characterId);
    if (!c.template) {
      const t = templateOf(characterId);
      if (!t) return null;
      c.template = clone(t);
    }
    c.updatedAt = Date.now();
    return c.template;
  }

  /** 改今天（第一次改时把按模板的今天存下来） */
  function editToday(characterId: string): RhythmDay | null {
    const k = dayKey(characterId, today.value);
    if (!days[k]) {
      const d = todayOf(characterId);
      if (!d) return null;
      days[k] = clone(d);
    }
    const d = days[k] as RhythmDay;
    d.edited = true;
    return d;
  }

  /** 把今天存成模板（作息、三餐、手头的事；今天穿的几套没在衣柜里的放进衣柜） */
  function saveTodayAsTemplate(characterId: string): boolean {
    const d = todayOf(characterId);
    const t = editTemplate(characterId);
    if (!d || !t) return false;
    t.schedule = clone(d.schedule);
    t.meals = { ...d.meals };
    if (d.task) t.task = d.task;
    for (const [kind, o] of Object.entries(d.outfits) as [OutfitKind, DayOutfit][]) {
      if (o && !t.wardrobe.some((w) => w.name === o.name && w.tags === o.tags)) t.wardrobe.push({ id: uid('outfit'), kind, name: o.name, tags: o.tags });
    }
    return true;
  }

  /** 恢复成按模板（去掉今天排过、改过的） */
  function resetToday(characterId: string) {
    delete days[dayKey(characterId, today.value)];
  }

  // —— 交给「节律」——

  function characterLines(c: Character, user: string): string {
    const sub = (t: string) => substituteMacros(t, { char: c.name, user }).trim();
    return [
      `名字：${c.name}（界面里称呼"${c.pronoun}"）`,
      c.card.description ? `描述：${sub(c.card.description)}` : '',
      c.card.personality ? `性格：${sub(c.card.personality)}` : '',
      c.card.scenario ? `场景：${sub(c.card.scenario)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** 建世界的材料：角色卡的作者备注和绑定的世界书（开着的条目），太长时截断 */
  function sourceLines(c: Character, user: string): string {
    const lib = useLibraryStore();
    const parts: string[] = [];
    let budget = 9000;
    if (c.card.creatorNotes.trim()) parts.push(`作者备注：${c.card.creatorNotes.trim().slice(0, 600)}`);
    for (const id of c.lorebookIds) {
      const book = lib.lorebookById(id);
      if (!book) continue;
      for (const e of book.entries) {
        if (!e.enabled || !e.content.trim() || budget <= 0) continue;
        const title = e.comment || e.keys.slice(0, 3).join('、');
        const text = substituteMacros(e.content, { char: c.name, user }).trim().slice(0, Math.min(1200, budget));
        budget -= text.length;
        parts.push(`【${title}】${text}`);
      }
    }
    return parts.length ? `世界书和设定：\n${parts.join('\n')}` : '';
  }

  function worldLines(characterId: string): string {
    const w = worldOf(characterId);
    const people = configOf(characterId).people;
    return [
      `${w.name}：${w.blurb}`,
      '地点（id：名字 · 室内或室外 · 能一起做的事 · 一句话）：',
      ...w.locations.map((l) => `- ${l.id}：${l.name} · ${l.indoor ? '室内' : '室外'} · ${l.activities.map((a) => a.label).join('、') || '—'}${l.blurb ? ` · ${l.blurb}` : ''}`),
      people.length ? `身边的人：\n${people.map((p) => `- ${p.name}（${p.relation}）${p.note ? `：${p.note}` : ''}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function scheduleLines(schedule: RhythmSlot[]): string {
    return schedule.map((s) => `- ${s.from}–${s.to} ${getLocation(s.locationId)?.name ?? s.locationId}（${s.locationId}）${s.status}${s.fixed ? '（固定，不能挪）' : ''}`).join('\n');
  }

  function templateLines(t: RhythmTemplate): string {
    return [
      `作息模板：\n${scheduleLines(t.schedule)}`,
      `三餐习惯：早饭${t.meals.breakfast || '—'}；午饭${t.meals.lunch || '—'}；晚饭${t.meals.dinner || '—'}`,
      t.task ? `最近手头的事：${t.task}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function wardrobeLines(t: RhythmTemplate): string {
    if (!t.wardrobe.length) return '衣柜：还是空的';
    return `衣柜：\n${t.wardrobe.map((o) => `- [${OUTFIT_KINDS[o.kind]}] ${o.name}：${o.tags}`).join('\n')}`;
  }

  function todayLines(date: string): string {
    const d = new Date(`${date}T12:00:00`);
    const term = solarTermNote(d);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    return `今天：${date} ${WEEKDAYS[d.getDay()]}（${weekend ? '周末' : '工作日'}）${term ? ` · ${term}` : ''}`;
  }

  function recentLines(characterId: string): string {
    const list = recentDays(characterId, 3);
    if (!list.length) return '';
    return `最近几天：\n${list
      .map((d) => {
        const busy = d.schedule.filter((s) => !/睡/.test(s.status)).map((s) => `${s.from} ${s.status}`).join('，');
        const wear = (Object.entries(d.outfits) as [OutfitKind, DayOutfit][]).map(([k, o]) => `${OUTFIT_KINDS[k]}：${o.name}`).join('；');
        return `- ${d.date}：${busy}${wear ? `；穿 ${wear}` : ''}${d.meals.dinner ? `；晚饭${d.meals.dinner}` : ''}`;
      })
      .join('\n')}`;
  }

  function promiseLines(characterId: string): string {
    const chat = useChatStore();
    const c = chat.chatOfCharacter(characterId);
    if (!c) return '';
    const summary = (c.summaries ?? []).slice(-2).map((s) => s.text).join('\n');
    const recent = chat.recentLines(c.id, 8);
    return [summary ? `最近的聊天摘要：\n${summary}` : '', recent.length ? `最近的聊天：\n${recent.join('\n')}` : ''].filter(Boolean).join('\n');
  }

  function userName(characterId: string): string {
    const chat = useChatStore().chatOfCharacter(characterId);
    return personas.find((p) => p.id === chat?.personaId)?.name ?? personas.find((p) => p.isDefault)?.name ?? '你';
  }

  /** 调「节律」：按节律预设拼提示词，读回 JSON */
  async function callRhythm<T>(
    characterId: string,
    task: 'build-world' | 'plan-day',
    fills: Partial<Record<RhythmFill, string>>,
    parse: (v: unknown) => T | null,
    outfitMode?: 'pick' | 'new' | null,
  ): Promise<RhythmResult<{ value: T; model: string }>> {
    const ai = useAiStore();
    const c = useCharacterStore().byId(characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    const status = ai.status('rhythm');
    if (!status.live) return { ok: false, reason: `「节律」还没接通：${status.reason}`, notConnected: true };
    const preset = useLibraryStore().presetForUse('rhythm', c);
    if (!preset) return { ok: false, reason: '没有节律预设：去"我的 → 预设 → 节律"导入或恢复一个' };
    try {
      const messages = buildRhythmMessages({ task, outfitMode, characterName: c.name, userName: userName(characterId), fills }, preset);
      const { value, result } = await ai.system.json('rhythm', { messages, ...samplerRequest(preset.sampler) }, parse);
      return { ok: true, value: { value, model: result.model } };
    } catch (e) {
      return { ok: false, reason: errorText(e), detail: errorReport(e) };
    }
  }

  /**
   * 排今天：每天变化的几项交给「节律」，其余按模板；排出来的作息检查过、补过。
   * force：今天已经排过、改过也重新排
   */
  async function planToday(characterId: string, opts: { force?: boolean } = {}): Promise<RhythmResult<RhythmDay>> {
    const date = today.value;
    const k = dayKey(characterId, date);
    if (busy[characterId]) return { ok: false, reason: '正在排' };
    if (days[k] && !opts.force) return { ok: true, value: days[k] as RhythmDay };
    const template = templateOf(characterId);
    if (!template) return { ok: false, reason: '还没有小世界：先"建世界"' };
    const c = useCharacterStore().byId(characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    const { settings } = configOf(characterId);
    const vary = settings.mode === 'daily' ? settings.vary : { schedule: false, meals: false, outfits: false };
    const asks = [vary.schedule ? '作息' : '', vary.meals ? '三餐' : '', vary.outfits ? '穿着' : '', '手头的事', '一两件小事'].filter(Boolean);
    busy[characterId] = 'plan';
    try {
      const user = userName(characterId);
      const r = await callRhythm(
        characterId,
        'plan-day',
        {
          rhythmCharacter: characterLines(c, user),
          rhythmWorld: worldLines(characterId),
          rhythmTemplate: templateLines(template),
          rhythmWardrobe: vary.outfits || settings.mode === 'fixed' ? wardrobeLines(template) : '',
          rhythmToday: todayLines(date),
          rhythmRecent: recentLines(characterId),
          rhythmPromises: promiseLines(characterId),
          rhythmAsk: `这次要排的：${asks.join('、')}${vary.schedule ? '' : '（作息按模板，不用写）'}`,
        },
        parsePlanDay,
        vary.outfits ? settings.outfitMode : null,
      );
      if (!r.ok) {
        errors[characterId] = { at: Date.now(), reason: r.reason, detail: r.detail };
        return r;
      }
      const out = r.value.value;
      const base = dayFromTemplate(characterId, date, template);
      const fixes: string[] = [];
      let schedule = base.schedule;
      if (vary.schedule && out.schedule.length) {
        const checked = checkSchedule(out.schedule, { template, resolve: locationResolver(worldOf(characterId).locations, characterId) });
        schedule = checked.schedule;
        fixes.push(...checked.fixes);
      } else if (vary.schedule) fixes.push('没有排作息，按模板');
      const outfits = { ...base.outfits };
      if (vary.outfits) {
        for (const [kind, o] of Object.entries(out.outfits) as [OutfitKind, DayOutfit][]) if (o?.tags) outfits[kind] = o;
        if (settings.outfitMode === 'pick') {
          // 从衣柜挑：写了衣柜里没有的，换成那一类的第一套
          const fallback = defaultOutfits(template.wardrobe);
          for (const kind of Object.keys(outfits) as OutfitKind[]) {
            const o = outfits[kind];
            if (o && template.wardrobe.length && !template.wardrobe.some((w) => w.name === o.name || w.tags === o.tags)) {
              fixes.push(`"${o.name}"不在衣柜里，换成衣柜里的`);
              if (fallback[kind]) outfits[kind] = fallback[kind];
            }
          }
        }
      }
      const day: RhythmDay = {
        characterId,
        date,
        schedule,
        meals: vary.meals ? { ...base.meals, ...out.meals } : base.meals,
        outfits,
        task: out.task || base.task,
        events: out.events,
        source: 'model',
        model: r.value.model,
        at: Date.now(),
        ...(fixes.length ? { fixes } : {}),
      };
      days[dayKey(characterId, date)] = day;
      delete errors[characterId];
      return { ok: true, value: day };
    } finally {
      delete busy[characterId];
    }
  }

  /** 建世界：从角色卡和世界书生成她的世界、作息模板、衣柜、身边的人；先返回给你看 */
  async function buildWorld(characterId: string): Promise<RhythmResult<WorldPreview>> {
    const c = useCharacterStore().byId(characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    if (busy[characterId]) return { ok: false, reason: '正在忙' };
    busy[characterId] = 'build';
    try {
      const user = userName(characterId);
      const r = await callRhythm(characterId, 'build-world', { rhythmCharacter: characterLines(c, user), rhythmSource: sourceLines(c, user) }, parseBuiltWorld);
      if (!r.ok) return r;
      const built = worldFromSpec(characterId, c.name, r.value.value);
      return { ok: true, value: { ...built, model: r.value.model } };
    } finally {
      delete busy[characterId];
    }
  }

  /** 确认"建世界"的结果：存下世界、模板、身边的人；今天按新模板重来 */
  function applyWorld(characterId: string, preview: WorldPreview) {
    const world = clone(preview.world);
    worlds[characterId] = world;
    registerWorld(world);
    const c = ensureConfig(characterId);
    c.template = clone(preview.template);
    c.people = clone(preview.people);
    c.updatedAt = Date.now();
    resetToday(characterId);
    tick();
  }

  /** 删掉生成的世界（演示角色的世界不能删） */
  function removeWorld(characterId: string) {
    if (!worlds[characterId]) return;
    delete worlds[characterId];
    unregisterWorld(characterId);
    const c = ensureConfig(characterId);
    c.template = null;
    c.people = [];
    resetToday(characterId);
  }

  // —— 每分钟：她此刻在哪；每天变化的在当天第一次打开时排 ——

  /** 自动排失败后，这个角色一小时内不再自动试（完整报错在节律页） */
  const backoff = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function tick() {
    today.value = rhythmDate(new Date());
    const chars = useCharacterStore();
    const chat = useChatStore();
    const ai = useAiStore();
    for (const c of chars.list) {
      // 正在一起做事：她在你们那儿，不按作息挪
      if (chat.chatOfCharacter(c.id)?.togetherAt) continue;
      const slot = slotNow(c.id);
      if (slot && getLocation(slot.locationId)) Object.assign(c, { locationId: slot.locationId, status: slot.status });
      const cfg = configs[c.id];
      if (cfg?.settings.mode !== 'daily' || days[dayKey(c.id, today.value)] || busy[c.id]) continue;
      if ((backoff.get(c.id) ?? 0) > Date.now() || !ai.isLive('rhythm') || !templateOf(c.id)) continue;
      void planToday(c.id).then((r) => {
        if (!r.ok) backoff.set(c.id, Date.now() + 3_600_000);
        else tick();
      });
    }
  }

  function start() {
    tick();
    clearInterval(timer);
    timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
  }

  return {
    configs,
    days,
    worlds,
    busy,
    errors,
    today,
    hydrate,
    start,
    tick,
    configOf,
    hasWorld,
    templateOf,
    dayOf,
    todayOf,
    recentDays,
    outfitFor,
    taskOf,
    mealsOf,
    slotNow,
    setSettings,
    editTemplate,
    editToday,
    saveTodayAsTemplate,
    resetToday,
    planToday,
    buildWorld,
    applyWorld,
    removeWorld,
  };
});
