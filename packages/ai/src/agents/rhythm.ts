import { assembleTaskPrompt, OUTFIT_KINDS, solarTermNote, substituteMacros, type RhythmContext, type RhythmDay, type RhythmSlot, type RhythmTask } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 节律智能体（设计文档 §4.1、§9 开头）：
 * - 建世界：从角色卡和世界书里找出她住哪、在哪读书或工作、常去哪、身边有谁，写出作息模板、三餐习惯、衣柜；
 * - 排今天：按她的世界、模板、今天的日期天气、最近几天，排今天的作息、三餐、穿着、手头的事。
 * 提示词（任务、规则、输出格式）全在节律预设里，按触发条件只发这次的任务；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseBuiltWorld / parsePlanDay 读，再用 checkSchedule 检查。
 */

/** 节律预设的程序填充块（TASK_MARKERS.rhythm） */
export type RhythmFill =
  | 'rhythmCharacter'
  | 'rhythmSource'
  | 'rhythmWorld'
  | 'rhythmTemplate'
  | 'rhythmWardrobe'
  | 'rhythmToday'
  | 'rhythmRecent'
  | 'rhythmPromises'
  | 'rhythmAsk';

export interface RhythmPromptInput {
  task: Extract<RhythmTask, 'build-world' | 'plan-day'>;
  /** 排今天、穿着每天变化时：从衣柜里挑（outfit-pick）还是每天新编（outfit-new） */
  outfitMode?: 'pick' | 'new' | null;
  characterName: string;
  userName?: string;
  fills: Partial<Record<RhythmFill, string>>;
}

/** 这一次的类型：任务名，排今天时再加上穿着的做法 */
export function rhythmTypes(input: Pick<RhythmPromptInput, 'task' | 'outfitMode'>): string[] {
  return [input.task, ...(input.task === 'plan-day' && input.outfitMode ? [`outfit-${input.outfitMode}`] : [])];
}

export function buildRhythmMessages(input: RhythmPromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { char: input.characterName, user: input.userName ?? '' }, type: rhythmTypes(input) }).messages;
}

/** Rebuilt at execution time: cloud dates and recent days never depend on an open PWA. */
export function planDayInput(context: RhythmContext, date: string, recent: RhythmDay[]): RhythmPromptInput {
  const { character: c, userName, settings, template: t, world: w, people } = context;
  const vary = settings.mode === 'daily' ? settings.vary : { schedule: false, meals: false, outfits: false };
  const sub = (text: string) => substituteMacros(text, { char: c.name, user: userName }).trim();
  const schedule = (slots: RhythmSlot[]) => slots.map((s) => `- ${s.from}–${s.to} ${w.locations.find((l) => l.id === s.locationId)?.name ?? s.locationId}（${s.locationId}）${s.status}${s.fixed ? '（固定，不能挪）' : ''}`).join('\n');
  const d = new Date(`${date}T12:00:00`);
  const term = solarTermNote(d);
  const weekday = d.getDay();
  const asks = [vary.schedule ? '作息' : '', vary.meals ? '三餐' : '', vary.outfits ? '穿着' : '', '手头的事', '一两件小事'].filter(Boolean);
  return {
    task: 'plan-day', outfitMode: vary.outfits ? settings.outfitMode : null, characterName: c.name, userName,
    fills: {
      rhythmCharacter: [`名字：${c.name}（界面里称呼"${c.pronoun}"）`, c.card.description ? `描述：${sub(c.card.description)}` : '',
        c.card.personality ? `性格：${sub(c.card.personality)}` : '', c.card.scenario ? `场景：${sub(c.card.scenario)}` : ''].filter(Boolean).join('\n'),
      rhythmWorld: [`${w.name}：${w.blurb}`, '地点（id：名字 · 室内或室外 · 能一起做的事 · 一句话）：',
        ...w.locations.map((l) => `- ${l.id}：${l.name} · ${l.indoor ? '室内' : '室外'} · ${l.activities.map((a) => a.label).join('、') || '—'}${l.blurb ? ` · ${l.blurb}` : ''}`),
        people.length ? `身边的人：\n${people.map((p) => `- ${p.name}（${p.relation}）${p.note ? `：${p.note}` : ''}`).join('\n')}` : ''].filter(Boolean).join('\n'),
      rhythmTemplate: [`作息模板：\n${schedule(t.schedule)}`, `三餐习惯：早饭${t.meals.breakfast || '—'}；午饭${t.meals.lunch || '—'}；晚饭${t.meals.dinner || '—'}`, t.task ? `最近手头的事：${t.task}` : ''].filter(Boolean).join('\n'),
      rhythmWardrobe: vary.outfits || settings.mode === 'fixed' ? (t.wardrobe.length ? `衣柜：\n${t.wardrobe.map((o) => `- [${OUTFIT_KINDS[o.kind]}] ${o.name}：${o.tags}`).join('\n')}` : '衣柜：还是空的') : '',
      rhythmToday: `今天：${date} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday]}（${weekday === 0 || weekday === 6 ? '周末' : '工作日'}）${term ? ` · ${term}` : ''}`,
      rhythmRecent: recent.length ? `最近几天：\n${recent.map((day) => `- ${day.date}：${day.schedule.filter((s) => !/睡/.test(s.status)).map((s) => `${s.from} ${s.status}`).join('，')}；穿 ${Object.values(day.outfits).map((o) => o?.name).filter(Boolean).join('、')}；晚饭${day.meals.dinner}`).join('\n')}` : '',
      rhythmPromises: context.promises,
      rhythmAsk: `这次要排的：${asks.join('、')}${vary.schedule ? '' : '（作息按模板，不用写）'}`,
    },
  };
}
