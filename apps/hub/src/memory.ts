import { AgentSystem, AiError, runConsolidation } from '@app/ai';
import { rhythmDate, shiftDate, type MemoryConsolidationContext, type MemoryJobResult, type ProactiveCredentials } from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { setMeta } from './scheduler.ts';

/**
 * 记忆整理（"记忆整理"的 API 和"整理"预设）：每个角色每天凌晨 4 点（按手机同步来的时区）整理一次，
 * PWA 关着也会跑。整理什么由手机打包上传（可能重复的记忆、该合并的时间线、过期的待跟进、画像卡和新记忆），
 * 结果写成一串修改存进 D1，手机打开时拉取应用（你在手机上改过的那一处跳过）。
 * - 每个角色、每一天单独领取（租约），重叠的 Cron 不会重复整理；失败在后面的 Cron 里重试；
 * - 上一次整理过的那份上下文没有变化（手机没上传新的）就不再整理；
 * - 不检查每日 token 预算。
 */

interface ContextRow { character_id: string; revision: number; data: string }
/** 四件事各一次调用，给足时间 */
const LEASE_MS = 900_000;

export type Consolidator = typeof runConsolidation;

async function consolidateOne(env: Env, row: ContextRow, credentials: ProactiveCredentials, now: number, run: Consolidator) {
  const ctx = JSON.parse(row.data) as MemoryConsolidationContext;
  const id = row.character_id;
  const date = rhythmDate(new Date(now), ctx.timezone);
  const done = await env.DB.prepare('SELECT context_revision FROM memory_jobs WHERE character_id = ? AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT 1')
    .bind(id).first<{ context_revision: number }>();
  if (done && done.context_revision >= row.revision) return;
  const lease = crypto.randomUUID();
  const claim = await env.DB.prepare(`INSERT INTO memory_jobs(character_id, date, context_revision, lease, lease_until, attempts)
    VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(character_id, date) DO UPDATE SET
      context_revision = excluded.context_revision, lease = excluded.lease, lease_until = excluded.lease_until, attempts = memory_jobs.attempts + 1
    WHERE memory_jobs.result IS NULL AND memory_jobs.lease_until <= ? AND memory_jobs.retry_at <= ? RETURNING attempts`)
    .bind(id, date, row.revision, lease, now + LEASE_MS, now, now).first<{ attempts: number }>();
  if (!claim) return;
  try {
    const system = new AgentSystem({
      config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (k) => credentials.keys[k] || null },
      outputFilters: credentials.outputFilters,
    });
    const { ops, errors } = await run(system, ctx, { signal: AbortSignal.timeout(LEASE_MS - 30_000) });
    // 四件事都失败了：算这次失败，稍后重试
    if (!ops.length && errors.length) throw new AiError('bad_response', errors.join('；'));
    const result: MemoryJobResult = { characterId: id, date, ops, context: ctx, errors, at: now };
    const saved = await env.DB.prepare(`UPDATE memory_jobs SET result = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = ?, done_at = ?
      WHERE character_id = ? AND date = ? AND lease = ?
      AND EXISTS (SELECT 1 FROM memory_contexts WHERE character_id = ? AND revision = ?)`)
      .bind(JSON.stringify(result), errors.length ? errors.join('；').slice(0, 300) : null, Date.now(), id, date, lease, id, row.revision).run();
    if (!saved.meta.changes) throw new Error('整理期间手机上传了新的记忆');
  } catch (e) {
    // 服务商的报错里可能有 Key 或响应原文：只同步安全的摘要
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.message.slice(0, 80) : 'Error';
    await env.DB.prepare(`UPDATE memory_jobs SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE character_id = ? AND date = ? AND lease = ?`)
      .bind(now + Math.min(60, 5 * 2 ** Math.min(claim.attempts - 1, 4)) * 60_000, `记忆整理失败（${reason}），云端将自动重试`, id, date, lease).run();
    throw e;
  }
}

/** 每 5 分钟的 Cron 里跑：到了各自时区的凌晨 4 点就整理当天的；失败的、4 点后才接通的都会补上 */
export async function runMemoryScheduled(env: Env, now = Date.now(), run: Consolidator = runConsolidation) {
  const rows = await env.DB.prepare('SELECT character_id, revision, data FROM memory_contexts').all<ContextRow>();
  if (!rows.results.length) return;
  const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'consolidate'").first<{ ciphertext: string; iv: string }>();
  if (!sealed) {
    await setMeta(env, 'lastMemoryError', '未设置云端记忆整理 API，请打开 App 同步');
    return;
  }
  const credentials = await unseal<ProactiveCredentials>(env.KEK, sealed);
  const results = await Promise.allSettled(rows.results.map((row) => consolidateOne(env, row, credentials, now, run)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  await Promise.all([
    env.DB.prepare('DELETE FROM memory_jobs WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -14)).run(),
    setMeta(env, 'lastMemoryError', failed ? `${failed} 个角色的记忆整理失败，下一轮继续` : null),
  ]);
}
