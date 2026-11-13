import { estimateTokens, inWindow, planTouchpoints, shiftDate, zonedDateKey, zonedParts,
  type Message, type ProactiveContext, type ProactiveCredentials, type Touchpoint } from '@app/shared';
import { AiError } from '@app/ai';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { generateMessage, proactivePrompt } from './generate.ts';
import { deliverPending, notificationFor } from './push.ts';

export type Generator = typeof generateMessage;
interface ContextRow { character_id: string; data: string; revision: number; updated_at: number }
interface PointRow { id: string; data: string; attempts: number }
const LEASE_MS = 180_000;
const CATCH_UP_MS = 3 * 3_600_000;

export async function setMeta(env: Env, key: string, value: unknown) {
  await env.DB.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value)).run();
}
export async function getMeta<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
  return row ? JSON.parse(row.value) as T : fallback;
}

export async function planContext(env: Env, row: ContextRow, now: number) {
  const context = JSON.parse(row.data) as ProactiveContext;
  if (!context.character.proactive.enabled) return;
  const today = zonedDateKey(now, context.environment.timezone);
  const points = [-1, 0, 1].flatMap((offset) => planTouchpoints({
    character: context.character, rules: context.rules, env: context.environment,
    day: new Date(now), date: shiftDate(today, offset),
    followups: context.memories.filter((m) => m.type === 'followup' && m.dueAt).map((m) => ({ ...m, dueAt: m.dueAt! })),
  }));
  // Dates are materialized by Cron itself, including after several days without any client.
  // A timezone change also moves overdue, unclaimed work. Completed IDs are never resurrected.
  if (!points.length) return;
  await env.DB.batch(points.map((t) => env.DB.prepare(`
    INSERT INTO touchpoints(id, character_id, rule_id, due_at, status, data)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM contexts WHERE character_id = ? AND revision = ?)
    ON CONFLICT(id) DO UPDATE SET due_at = excluded.due_at, data = excluded.data, status = excluded.status, retry_at = 0, last_error = NULL
    WHERE touchpoints.status IN ('planned', 'skipped') AND touchpoints.lease_until <= ?
      AND (touchpoints.due_at > ? OR touchpoints.due_at != excluded.due_at
        OR COALESCE(json_extract(touchpoints.data, '$.timezone'), ?) != ?)
  `).bind(t.id, t.characterId, t.ruleId, t.dueAt, t.status, JSON.stringify(t), row.character_id, row.revision, now, now, t.timezone, t.timezone)));
}

export function gate(context: ProactiveContext, t: Touchpoint, now: number): string | null {
  const p = context.character.proactive;
  const rule = context.rules.find((r) => r.id === t.ruleId);
  if (!p.enabled || !p.triggers.includes(t.ruleId) || !rule?.enabled) return '该角色或规则已关闭';
  if (t.action === 'call' && !p.allowCalls) return '没有允许主动来电';
  if (now - t.dueAt > CATCH_UP_MS) return '超过 3 小时补发窗口';
  const time = zonedParts(now, context.environment.timezone);
  if (t.ruleId !== 'wake-call' && inWindow(time.hour * 60 + time.minute, p.quietHours.start, p.quietHours.end)) return '勿扰时段';
  const lastUser = context.history.filter((m) => m.role === 'user' && !m.deleted).reduce((n, m) => Math.max(n, m.createdAt), 0);
  if (lastUser && now - lastUser < 20 * 60_000) return '你 20 分钟内刚聊过';
  if (context.busyUntil > now) return '正在学习或哄睡';
  // After two unanswered messages, check at most once every six hours (not forever).
  const unanswered = context.history.filter((m) => m.proactive && m.createdAt > lastUser && !m.deleted);
  const last = Math.max(0, ...unanswered.map((m) => m.createdAt));
  if (unanswered.length >= 2 && now - last < 6 * 3_600_000) return '连续两条未回复，退避 6 小时';
  return null;
}

export async function reserve(env: Env, id: string, date: string, tokens: number, budget: number, now: number): Promise<boolean> {
  const result = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO usage(date) VALUES (?)').bind(date),
    env.DB.prepare(`INSERT INTO reservations(id, date, tokens, expires_at)
      SELECT ?, ?, ?, ? FROM usage WHERE date = ? AND (? = 0 OR tokens + reserved + ? <= ?)`)
      .bind(id, date, tokens, now + LEASE_MS, date, budget, tokens, budget),
    env.DB.prepare('UPDATE usage SET reserved = reserved + ? WHERE date = ? AND EXISTS (SELECT 1 FROM reservations WHERE id = ?)').bind(tokens, date, id),
  ]);
  return result[1]!.meta.changes > 0;
}

export async function release(env: Env, id: string, used: number) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE usage SET reserved = MAX(0, reserved - (SELECT tokens FROM reservations WHERE id = ?)), tokens = tokens + ?
      WHERE date = (SELECT date FROM reservations WHERE id = ?)`).bind(id, used, id),
    env.DB.prepare('DELETE FROM reservations WHERE id = ?').bind(id),
  ]);
}

export async function releaseExpired(env: Env, now: number) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE usage SET reserved = MAX(0, reserved - COALESCE((SELECT SUM(tokens) FROM reservations WHERE reservations.date = usage.date AND expires_at <= ?), 0))`).bind(now),
    env.DB.prepare('DELETE FROM reservations WHERE expires_at <= ?').bind(now),
  ]);
}

async function fire(env: Env, point: PointRow, credentials: ProactiveCredentials, now: number, generate: Generator) {
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE touchpoints SET lease = ?, lease_until = ?, attempts = attempts + 1
    WHERE id = ? AND status = 'planned' AND due_at <= ? AND lease_until <= ? AND retry_at <= ? RETURNING data`)
    .bind(lease, now + LEASE_MS, point.id, now, now, now).first<{ data: string }>();
  if (!claimed) return;
  let used = 0;
  try {
    const t = JSON.parse(claimed.data) as Touchpoint;
    const row = await env.DB.prepare('SELECT * FROM contexts WHERE character_id = ?').bind(t.characterId).first<ContextRow>();
    if (!row) {
      await skip('角色已删除');
      return;
    }
    const context = JSON.parse(row.data) as ProactiveContext;
    if (t.timezone && t.timezone !== context.environment.timezone) {
      await skip('时区已更改，旧计划已取消');
      return;
    }
    const serverHistory = await env.DB.prepare('SELECT data FROM messages WHERE character_id = ? ORDER BY created_at DESC LIMIT 200').bind(t.characterId).all<{ data: string }>();
    const history = new Map(serverHistory.results.map((m) => { const v = JSON.parse(m.data) as Message; return [v.id, v] as const; }));
    // Client edits/read states win for the same message; cloud messages missing from the client remain.
    for (const m of context.history) history.set(m.id, m);
    context.history = [...history.values()].sort((a, b) => a.createdAt - b.createdAt);
    const reason = gate(context, t, now);
    if (reason) { await skip(reason); return; }
    const rule = context.rules.find((r) => r.id === t.ruleId)!;
    const recent = await env.DB.prepare(`SELECT id FROM touchpoints WHERE character_id = ? AND rule_id = ? AND status IN ('fired', 'delivered', 'opened')
      AND due_at > ? AND id != ? LIMIT 1`).bind(t.characterId, t.ruleId, now - rule.cooldownMin * 60_000, t.id).first();
    if (recent) { await skip('同一规则冷却中'); return; }
    const budget = credentials.routes.find((r) => r.role === 'proactive')?.dailyTokenBudget ?? 0;
    const request = t.action === 'call' ? null : proactivePrompt(context, t, now, 'budget-estimate');
    const estimate = request ? estimateTokens(JSON.stringify(request.messages)) + (request.maxTokens ?? 600) : 0;
    if (!await reserve(env, lease, zonedDateKey(now, context.environment.timezone), estimate, budget, now)) {
      await skip('主动消息每日 token 预算已用完');
      return;
    }
    const message = await generate(context, credentials, t, now);
    used = message.meta.tokens ?? 0;
    // Re-read after the model call: a user may disable the role or start chatting while it runs.
    const latest = await env.DB.prepare('SELECT * FROM contexts WHERE character_id = ?').bind(t.characterId).first<ContextRow>();
    const enabled = await getMeta(env, 'enabled', false);
    if (!enabled || !latest) { await skip('云端主动消息已停止'); return; }
    const current = JSON.parse(latest.data) as ProactiveContext;
    const changed = latest.revision !== row.revision;
    if (changed) {
      if (current.environment.timezone !== context.environment.timezone) throw new Error('生成期间时区有更新，下次检测重新排期');
      const currentGate = gate(current, t, Date.now());
      if (currentGate) { await skip(currentGate); return; }
      // Regenerate from changed context on the next tick; never publish stale generated content.
      throw new Error('生成期间上下文有更新，下次检测重试');
    }
    const fired = { ...t, status: 'fired', messageId: message.id, updatedAt: now };
    // Claim, message insert and final state use the same lease. Retrying Cron can't duplicate an ID.
    const committed = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO messages(id, character_id, touchpoint_id, created_at, data, notification)
        SELECT ?, ?, ?, ?, ?, ? FROM touchpoints WHERE id = ? AND lease = ? AND status = 'planned'
        AND EXISTS (SELECT 1 FROM contexts WHERE character_id = ? AND revision = ?)
        AND EXISTS (SELECT 1 FROM meta WHERE key = 'enabled' AND value = 'true')`)
        .bind(message.id, t.characterId, t.id, now, JSON.stringify(message), JSON.stringify(notificationFor(current, t, message)), t.id, lease, t.characterId, row.revision),
      env.DB.prepare(`UPDATE touchpoints SET status = 'fired', data = ?, lease = NULL, lease_until = 0, last_error = NULL
        WHERE id = ? AND lease = ? AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`)
        .bind(JSON.stringify(fired), t.id, lease, message.id),
    ]);
    if (!committed[1]!.meta.changes) throw new Error('提交前上下文或总开关有更新，下次检测重试');
  } catch (e) {
    // Do not persist provider responses/URLs: they may contain credentials. Details remain in provider logs.
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.name : 'Error';
    await env.DB.prepare('UPDATE touchpoints SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE id = ? AND lease = ?')
      .bind(now + Math.min(30, 5 * 2 ** Math.min(point.attempts, 3)) * 60_000, `生成失败（${reason}），将自动重试`, point.id, lease).run();
  } finally {
    await release(env, lease, used);
  }
  async function skip(reason: string) {
    const t = JSON.parse(claimed!.data) as Touchpoint;
    await env.DB.prepare("UPDATE touchpoints SET status = 'skipped', data = ?, lease = NULL, lease_until = 0 WHERE id = ? AND lease = ?")
      .bind(JSON.stringify({ ...t, status: 'skipped', skipReason: reason, updatedAt: now }), point.id, lease).run();
  }
}

export async function runScheduled(env: Env, now = Date.now(), generate: Generator = generateMessage) {
  await setMeta(env, 'lastCronAt', now);
  try {
    if (!await getMeta(env, 'enabled', false)) return;
    const [rows, sealed] = await Promise.all([
      env.DB.prepare('SELECT * FROM contexts').all<ContextRow>(),
      env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'proactive'").first<{ ciphertext: string; iv: string }>(),
    ]);
    if (!sealed) throw new Error('未设置云端主动消息 API');
    const credentials = await unseal<ProactiveCredentials>(env.KEK, sealed);
    // Recover reservations left by an evicted Worker; no global mutex or serial job queue.
    await releaseExpired(env, now);
    const plans = await Promise.allSettled(rows.results.map((row) => planContext(env, row, now)));
    const due = await env.DB.prepare("SELECT id, data, attempts FROM touchpoints WHERE status = 'planned' AND due_at <= ? AND retry_at <= ? AND lease_until <= ?").bind(now, now, now).all<PointRow>();
    const fired = await Promise.allSettled([
      deliverPending(env, now),
      ...due.results.map(async (row) => {
        await fire(env, row, credentials, now, generate);
        // Deliver as soon as this role commits; a slow model must not delay other notifications.
        await deliverPending(env, now, row.id);
      }),
    ]);
    const failed = [...plans, ...fired].filter((r) => r.status === 'rejected');
    if (failed.length) throw new Error(`${failed.length} 个云端任务失败，下一轮继续检测`);
    await setMeta(env, 'lastError', null);
  } catch (e) {
    await setMeta(env, 'lastError', e instanceof Error ? e.message : '云端检测失败');
    throw e;
  }
}
