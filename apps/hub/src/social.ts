import { AgentSystem, AiError, buildSocialMessages, samplerRequest, socialPostInput } from '@app/ai';
import { estimateTokens, hubMomentId, momentDueTimes, momentExtras, parseMomentDraft, rhythmDate, shiftDate, socialDayOf, zonedDateKey,
  type HubNotification, type Moment, type ProactiveCredentials, type RhythmContext, type RhythmDay, type SocialContext, type SocialDay } from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { sendChannel, type Channel } from './push.ts';
import { release, releaseExpired, reserve, setMeta } from './scheduler.ts';

/**
 * 朋友圈（"社媒 · 朋友圈"的 API 和"社媒"预设）：每个角色每天在随机的时间发 1 到几条朋友圈，PWA 关着也发。
 * - 什么时候发：按角色和日期算出来的随机时间（@app/shared 的 momentSlots，她醒着的时段里），到点的 Cron 领取那一条；
 * - 发什么：手机上传的角色卡、记忆、最近的聊天，加上今天的节律——云端排过今天（每天变化的节律）就用云端那份，
 *   没有就用手机上传的；手机上传之后云端又发过的也带上，免得好几天不开 App 时重复；
 * - 每个角色、每一天、每一条单独领取（租约），重叠的 Cron 不会重复发；失败在后面的 Cron 里重试，超过 3 小时的不补；
 * - 图不在云端画：模型写下要配的画面，手机收到后用"生图"画。单据（一小页 HTML）随正文一起存。
 */

interface ContextRow { character_id: string; revision: number; data: string; updated_at: number }
const LEASE_MS = 180_000;
const CATCH_UP_MS = 3 * 3_600_000;

export function socialRequest(context: SocialContext, now: number, day: SocialDay | null) {
  if (!context.preset) throw new Error('没有社媒预设');
  return { messages: buildSocialMessages(socialPostInput(context, now, day), context.preset), ...samplerRequest(context.preset.sampler) };
}

export async function generateMoment(context: SocialContext, credentials: ProactiveCredentials, id: string, now: number, day: SocialDay | null): Promise<{ moment: Moment; tokens: number }> {
  // The scheduler reserves the user-configured budget in D1 across concurrent characters.
  const system = new AgentSystem({ config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (k) => credentials.keys[k] || null }, outputFilters: credentials.outputFilters });
  const { value, result } = await system.json('social', socialRequest(context, now, day), parseMomentDraft, { signal: AbortSignal.timeout(150_000) });
  const moment: Moment = {
    id, authorId: context.character.id, text: value.text,
    images: value.image ? [{ caption: value.image, assetKey: null }] : [],
    ...(value.html ? { html: value.html, htmlTitle: value.htmlTitle || '单据' } : {}),
    ...(value.location ? { location: value.location } : {}),
    visibleTo: null, likes: [], comments: [], createdAt: now, updatedAt: now, source: 'hub', model: result.model, unread: true,
  };
  return { moment, tokens: system.usedToday('social') };
}

export type MomentGenerator = typeof generateMoment;

/** 云端自己排的今天（每天变化的节律）；没有时用手机上传的那份 */
async function todayOf(env: Env, context: SocialContext, now: number): Promise<SocialDay | null> {
  const id = context.character.id;
  const date = rhythmDate(new Date(now), context.timezone);
  const [day, world] = await Promise.all([
    env.DB.prepare('SELECT data FROM rhythm_days WHERE character_id = ? AND date = ? AND data IS NOT NULL').bind(id, date).first<{ data: string }>(),
    env.DB.prepare('SELECT data FROM rhythm_contexts WHERE character_id = ?').bind(id).first<{ data: string }>(),
  ]);
  if (!day || !world) return context.day?.date === date ? context.day : null;
  const locations = (JSON.parse(world.data) as RhythmContext).world.locations;
  return socialDayOf(JSON.parse(day.data) as RhythmDay, (loc) => locations.find((l) => l.id === loc)?.name ?? loc);
}

function notificationFor(context: SocialContext, moment: Moment): HubNotification {
  const body = moment.text || momentExtras(moment) || '发了一条朋友圈';
  return {
    title: context.preview === 'hidden' ? 'AI 陪伴' : context.character.name,
    body: context.preview === 'full' ? `朋友圈：${body.slice(0, 300)}` : context.preview === 'name-only' ? '发了一条朋友圈' : '朋友圈有新动态',
    tag: moment.id, route: '/moments',
  };
}

async function postOne(env: Env, row: ContextRow, slot: number, dueAt: number, date: string, credentials: ProactiveCredentials, now: number, generate: MomentGenerator) {
  const context = JSON.parse(row.data) as SocialContext;
  const id = row.character_id;
  const lease = crypto.randomUUID();
  // Each character/date/slot has its own atomic claim. Other characters start immediately.
  const claim = await env.DB.prepare(`INSERT INTO social_posts(character_id, date, slot, due_at, lease, lease_until, attempts)
    VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(character_id, date, slot) DO UPDATE SET
      due_at = excluded.due_at, lease = excluded.lease, lease_until = excluded.lease_until, attempts = social_posts.attempts + 1
    WHERE social_posts.data IS NULL AND social_posts.lease_until <= ? AND social_posts.retry_at <= ? RETURNING attempts`)
    .bind(id, date, slot, dueAt, lease, now + LEASE_MS, now, now).first<{ attempts: number }>();
  if (!claim) return;
  let used = 0;
  try {
    const [day, later] = await Promise.all([
      todayOf(env, context, now),
      // 手机上传之后云端又发过的：手机没来得及拉的那几条也算"发过的"
      env.DB.prepare('SELECT data FROM social_posts WHERE character_id = ? AND done_at > ? AND data IS NOT NULL ORDER BY done_at DESC LIMIT 6')
        .bind(id, row.updated_at).all<{ data: string }>(),
    ]);
    const mine = later.results.map((r) => JSON.parse(r.data) as Moment).reverse()
      .map((m) => `${zonedDateKey(m.createdAt, context.timezone)} ${context.character.name}发了朋友圈：${m.text ? `「${m.text}」` : ''}${momentExtras(m) ? `（${momentExtras(m)}）` : ''}`);
    const current: SocialContext = { ...context, feed: [context.feed, ...mine].filter(Boolean).join('\n') };
    const route = credentials.routes.find((r) => r.role === 'social');
    const request = socialRequest(current, now, day);
    const estimate = estimateTokens(JSON.stringify(request.messages)) + (request.maxTokens ?? route?.params?.maxTokens ?? 0);
    if (!await reserve(env, lease, `social:${date}`, estimate, route?.dailyTokenBudget ?? 0, now)) throw new AiError('budget', '朋友圈每日 token 预算已用完');
    const result = await generate(current, credentials, hubMomentId(id, date, slot), now, day);
    used = result.tokens;
    // A settings change/removal during the call invalidates the output, without blocking any other role.
    const saved = await env.DB.prepare(`UPDATE social_posts SET data = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = NULL, done_at = ?
      WHERE character_id = ? AND date = ? AND slot = ? AND lease = ?
      AND EXISTS (SELECT 1 FROM social_contexts WHERE character_id = ? AND revision = ?)`)
      .bind(JSON.stringify(result.moment), Date.now(), id, date, slot, lease, id, row.revision).run();
    if (!saved.meta.changes) throw new Error('生成期间朋友圈设置更新');
    // 通知发一次就好：发不出去不重发（朋友圈打开 App 就能看到），也不算这一条失败
    const channels = await env.DB.prepare('SELECT * FROM push_channels').all<Channel>();
    await Promise.allSettled(channels.results.map((ch) => sendChannel(env, ch, notificationFor(context, result.moment))));
  } catch (e) {
    // Provider messages may contain keys or response bodies; sync only a safe failure summary.
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.name : 'Error';
    await env.DB.prepare(`UPDATE social_posts SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE character_id = ? AND date = ? AND slot = ? AND lease = ?`)
      .bind(now + Math.min(30, 5 * 2 ** Math.min(claim.attempts - 1, 3)) * 60_000, `朋友圈生成失败（${reason}），云端将自动重试`, id, date, slot, lease).run();
  } finally {
    await release(env, lease, used);
  }
}

/** 这个角色现在到点、还在补发窗口里的那几条（昨天深夜的和今天的） */
function dueSlots(context: SocialContext, now: number): { date: string; slot: number; dueAt: number }[] {
  if (!context.settings.enabled) return [];
  const today = zonedDateKey(now, context.timezone);
  return [shiftDate(today, -1), today].flatMap((date) =>
    momentDueTimes({ characterId: context.character.id, date, perDay: context.settings.perDay, awake: context.awake, timezone: context.timezone })
      .map((dueAt, slot) => ({ date, slot, dueAt }))
      .filter((s) => s.dueAt <= now && now - s.dueAt < CATCH_UP_MS));
}

/** 每 5 分钟的 Cron 里跑；和主动消息的总开关无关，手机没开也发 */
export async function runSocialScheduled(env: Env, now = Date.now(), generate: MomentGenerator = generateMoment) {
  try {
    const rows = await env.DB.prepare('SELECT character_id, revision, data, updated_at FROM social_contexts').all<ContextRow>();
    if (!rows.results.length) { await setMeta(env, 'lastSocialError', null); return; }
    const due = rows.results.flatMap((row) => dueSlots(JSON.parse(row.data) as SocialContext, now).map((s) => ({ row, ...s })));
    if (due.length) {
      const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'social'").first<{ ciphertext: string; iv: string }>();
      if (!sealed) throw new Error('未设置云端朋友圈 API，请打开 App 同步');
      const credentials = await unseal<ProactiveCredentials>(env.KEK, sealed);
      await releaseExpired(env, now);
      const results = await Promise.allSettled(due.map((d) => postOne(env, d.row, d.slot, d.dueAt, d.date, credentials, now, generate)));
      if (results.some((r) => r.status === 'rejected')) throw new Error('部分朋友圈任务失败，下一轮继续检测');
    }
    await Promise.all([
      env.DB.prepare('DELETE FROM social_posts WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -14)).run(),
      setMeta(env, 'lastSocialError', null),
    ]);
  } catch (e) {
    await setMeta(env, 'lastSocialError', e instanceof Error ? e.message : '云端朋友圈检测失败');
    throw e;
  }
}
