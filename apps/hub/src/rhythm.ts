import { AgentSystem, AiError, buildRhythmMessages, planDayInput, samplerRequest } from '@app/ai';
import { estimateTokens, parsePlanDay, rhythmDate, rhythmDayFromPlan, shiftDate, zonedDateKey, type ProactiveCredentials, type RhythmContext, type RhythmDay } from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { release, releaseExpired, reserve, setMeta } from './scheduler.ts';

interface ContextRow { character_id: string; revision: number; data: string }
const LEASE_MS = 180_000;

export function rhythmRequest(context: RhythmContext, date: string, recent: RhythmDay[]) {
  if (!context.preset) throw new Error('没有节律预设');
  const messages = buildRhythmMessages(planDayInput(context, date, recent), context.preset);
  return { messages, ...samplerRequest(context.preset.sampler) };
}

export async function generateRhythm(context: RhythmContext, credentials: ProactiveCredentials, date: string, recent: RhythmDay[], now: number): Promise<{ day: RhythmDay; tokens: number }> {
  // The scheduler reserves the user-configured budget in D1 across concurrent characters.
  const system = new AgentSystem({ config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (id) => credentials.keys[id] || null }, outputFilters: credentials.outputFilters });
  const { value, result } = await system.json('rhythm', rhythmRequest(context, date, recent), parsePlanDay, { signal: AbortSignal.timeout(120_000) });
  return { day: rhythmDayFromPlan({ characterId: context.character.id, date, template: context.template, settings: context.settings,
    locations: context.world.locations, output: value, model: result.model, at: now }), tokens: system.usedToday('rhythm') };
}

async function planDay(env: Env, row: ContextRow, credentials: ProactiveCredentials, now: number, generate: typeof generateRhythm) {
  const context = JSON.parse(row.data) as RhythmContext;
  if (context.settings.mode !== 'daily') return;
  const date = rhythmDate(new Date(now), context.timezone);
  const id = row.character_id;
  const lease = crypto.randomUUID();
  // Each character/date has its own atomic claim. Other characters start immediately.
  const claim = await env.DB.prepare(`INSERT INTO rhythm_days(character_id, date, lease, lease_until, attempts)
    VALUES (?, ?, ?, ?, 1) ON CONFLICT(character_id, date) DO UPDATE SET
      lease = excluded.lease, lease_until = excluded.lease_until, attempts = rhythm_days.attempts + 1
    WHERE rhythm_days.data IS NULL AND rhythm_days.lease_until <= ? AND rhythm_days.retry_at <= ? RETURNING attempts`)
    .bind(id, date, lease, now + LEASE_MS, now, now).first<{ attempts: number }>();
  if (!claim) return;
  let used = 0;
  try {
    const previous = await env.DB.prepare(`SELECT data FROM rhythm_days WHERE character_id = ? AND date < ? AND date >= ? AND data IS NOT NULL ORDER BY date DESC LIMIT 3`)
      .bind(id, date, shiftDate(date, -7)).all<{ data: string }>();
    const recent = previous.results.map((d) => JSON.parse(d.data) as RhythmDay);
    const route = credentials.routes.find((r) => r.role === 'rhythm');
    const request = rhythmRequest(context, date, recent);
    const estimate = estimateTokens(JSON.stringify(request.messages)) + (request.maxTokens ?? route?.params?.maxTokens ?? 0);
    if (!await reserve(env, lease, `rhythm:${zonedDateKey(now, context.timezone)}`, estimate, route?.dailyTokenBudget ?? 0, now)) throw new AiError('budget', '节律每日 token 预算已用完');
    const result = await generate(context, credentials, date, recent, now);
    used = result.tokens;
    // A settings change/removal during the call invalidates the output, without blocking any other role.
    const saved = await env.DB.prepare(`UPDATE rhythm_days SET data = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = NULL
      WHERE character_id = ? AND date = ? AND lease = ?
      AND EXISTS (SELECT 1 FROM rhythm_contexts WHERE character_id = ? AND revision = ?)`)
      .bind(JSON.stringify(result.day), id, date, lease, id, row.revision).run();
    if (!saved.meta.changes) throw new Error('生成期间节律设置更新');
  } catch (e) {
    // Provider messages may contain keys or response bodies; sync only a safe failure summary.
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.name : 'Error';
    await env.DB.prepare(`UPDATE rhythm_days SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE character_id = ? AND date = ? AND lease = ?`)
      .bind(now + Math.min(30, 5 * 2 ** Math.min(claim.attempts - 1, 3)) * 60_000, `节律生成失败（${reason}），云端将自动重试`, id, date, lease).run();
  } finally {
    await release(env, lease, used);
  }
}

/** Runs even when proactive messaging is disabled and no device has opened the PWA. */
export async function runRhythmScheduled(env: Env, now = Date.now(), generate: typeof generateRhythm = generateRhythm) {
  try {
    const [rows, sealed] = await Promise.all([
      env.DB.prepare('SELECT character_id, revision, data FROM rhythm_contexts').all<ContextRow>(),
      env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'rhythm'").first<{ ciphertext: string; iv: string }>(),
    ]);
    if (!rows.results.length) { await setMeta(env, 'lastRhythmError', null); return; }
    if (!sealed) throw new Error('未设置云端节律 API，请打开 App 同步');
    const credentials = await unseal<ProactiveCredentials>(env.KEK, sealed);
    await releaseExpired(env, now);
    const results = await Promise.allSettled(rows.results.map((row) => planDay(env, row, credentials, now, generate)));
    if (results.some((r) => r.status === 'rejected')) throw new Error('部分节律任务失败，下一轮继续检测');
    await Promise.all([
      env.DB.prepare('DELETE FROM rhythm_days WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -32)).run(),
      setMeta(env, 'lastRhythmError', null),
    ]);
  } catch (e) {
    await setMeta(env, 'lastRhythmError', e instanceof Error ? e.message : '云端节律检测失败');
    throw e;
  }
}
