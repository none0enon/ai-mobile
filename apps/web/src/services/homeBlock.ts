import { formatChoreBlock, MEAL_LABEL, substituteMacros, type AppBlockFill, type LifeFlag, type Persona, type Preset } from '@app/shared';
import { useEnvironmentStore } from '@/stores/environment';
import { useHealthStore, workoutLine } from '@/stores/health';
import { useHomeStore } from '@/stores/home';
import { seedBlockContent } from '@/stores/library';

/**
 * "家务和健康"那一块（程序填充块 home，设计文档 §9.12、§9.13）：你开了家务、健康系统时，今天的情况写在这里，
 * 聊天、通话、一起做事、主动消息（本机和云端）都带上。她怎么反应写在预设里（"家务：你怎么反应""健康：你怎么反应"两块，
 * 触发条件写着 housework / health，没开的系统那一块不发）。两套都没开时这一块是空的，不发送。
 */

/** 你人设里开着的系统：预设里触发条件写了它们的块只在开着时发送 */
export function lifeFlags(persona: Persona | undefined): LifeFlag[] {
  const out: LifeFlag[] = [];
  if (persona?.housework?.enabled && persona.housework.chores.length) out.push('housework');
  if (persona?.health?.enabled) out.push('health');
  return out;
}

/** 现在几点；stepMin 给了就往前取整（上传云端的那份用半小时，免得每分钟都算"变了"） */
function clockNow(timeZone: string, stepMin = 0): string {
  const step = stepMin * 60_000;
  const at = step ? Math.floor(Date.now() / step) * step : Date.now();
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return '';
  }
}

/** 健康这几行：目标、今天练什么吃什么、今天练了没有 */
export function healthLines(persona: Persona): string {
  const h = persona.health;
  if (!h?.enabled) return '';
  const health = useHealthStore();
  const today = health.today();
  const day = health.dayOf(persona.id, today);
  const week = health.weekOf(persona.id);
  const done = health.logsOf(persona.id, today).filter((l) => l.date === today);
  const target = h.targetWeightKg && h.weightKg ? `（${h.weightKg} → ${h.targetWeightKg} kg）` : '';
  const lines = [`【健康】${persona.name}的目标：${h.goal.trim() || '保持健康'}${target}`];
  if (day?.workout && !day.rest) lines.push(`今天的健身计划：${day.workout.title} · ${day.workout.minutes} 分钟（${done.some((l) => l.mode === 'plan') ? '练过了' : done.length ? '照计划的还没练' : '还没练'}）`);
  else if (day?.rest) lines.push('今天的健身计划：休息');
  else {
    const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
    const planned = week?.days.find((d) => d.weekday === wd);
    lines.push(planned ? `这周的计划里今天：${planned.rest ? '休息' : `${planned.workout} ${planned.minutes} 分钟`}` : '今天的健身计划还没排');
  }
  if (day) {
    const meals = (['breakfast', 'lunch', 'dinner', 'snack'] as const)
      .map((k) => {
        const m = day.meals[k];
        return m ? `${MEAL_LABEL[k]} ${m.name}${m.cook && m.minutes ? `（自己做，约 ${m.minutes} 分钟）` : ''}` : '';
      })
      .filter(Boolean);
    if (meals.length) lines.push(`今天吃什么（计划）：${meals.join('；')}`);
  }
  if (done.length) lines.push(`今天练了：${done.map((l) => workoutLine(l, false)).join('；')}`);
  return lines.join('\n');
}

/**
 * 预设里没有"她怎么反应"那一块的（导入的 SillyTavern 预设、以前复制的）：用自带预设文件里的，接在今天的情况后面。
 * 预设里有（触发条件写着 housework / health 的块，开着关着都算你的选择）就不补
 */
export function missingRules(persona: Persona, preset: Pick<Preset, 'blocks'> | undefined, names: { char: string }): string[] {
  return lifeFlags(persona)
    .filter((f) => !preset?.blocks.some((b) => b.triggers?.includes(f)))
    .map((f) => seedBlockContent(f === 'housework' ? 'homeRules' : 'healthRules'))
    .filter((t): t is string => !!t)
    .map((t) => substituteMacros(t, { char: names.char, user: persona.name }));
}

/**
 * 这一块的内容；两套都没开时为 null（不发送）。
 * opts.stepMin：时间往前取整（上传云端时用 30）；opts.preset：这一轮的预设，里面没有"她怎么反应"的块时把自带的接在后面
 */
export function homeBlock(persona: Persona | undefined, opts: { stepMin?: number; preset?: Pick<Preset, 'blocks'>; characterName?: string } = {}): AppBlockFill | null {
  const flags = lifeFlags(persona);
  if (!persona || !flags.length) return null;
  const tz = useEnvironmentStore().settings.timezone;
  const parts: string[] = [];
  if (flags.includes('housework')) {
    const home = useHomeStore();
    parts.push(formatChoreBlock({ userName: persona.name, items: home.itemsFor(persona), recent: home.recentFor(persona), nowText: clockNow(tz, opts.stepMin), timeZone: tz }));
  }
  if (flags.includes('health')) parts.push(healthLines(persona));
  if (opts.preset) parts.push(...missingRules(persona, opts.preset, { char: opts.characterName ?? '' }));
  const content = parts.filter(Boolean).join('\n');
  if (!content) return null;
  return { content, source: `${persona.name}的${flags.map((f) => (f === 'housework' ? '家务' : '健康')).join('和')}（"共同的家"里勾的、健康计划、运动记录）` };
}
