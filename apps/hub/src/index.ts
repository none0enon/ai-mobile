import { AgentSystem } from '@app/ai';
import { zonedParts, type MemoryConsolidationContext, type MemoryJobResult, type ProactiveContext, type ProactiveCredentials, type RhythmContext, type Touchpoint } from '@app/shared';
import { digest, equalSecret, seal } from './crypto.ts';
import type { Env } from './env.ts';
import { PushDeliveryError, sendChannel, type Channel, type Webhook } from './push.ts';
import { getMeta, runScheduled, setMeta } from './scheduler.ts';
import { runRhythmScheduled } from './rhythm.ts';
import { runMemoryScheduled } from './memory.ts';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new HttpError(400, message);
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function body<T>(request: Request): Promise<T> {
  const value = await request.text();
  assert(new TextEncoder().encode(value).length <= 1_800_000, '请求内容太大');
  try { return JSON.parse(value) as T; } catch { throw new HttpError(400, '无效的 JSON'); }
}
function https(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}

async function login(request: Request, env: Env) {
  if (!env.HUB_PASSWORD || !env.KEK) throw new HttpError(503, 'Worker 尚未设置 HUB_PASSWORD / KEK');
  const now = Date.now();
  const bucket = `${await digest(request.headers.get('CF-Connecting-IP') ?? 'local')}:${Math.floor(now / 600_000)}`;
  const count = await env.DB.prepare(`INSERT INTO login_attempts(bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`).bind(bucket, now + 600_000).first<{ attempts: number }>();
  if (count!.attempts > 10) throw new HttpError(429, '登录尝试过多，10 分钟后重试');
  const data = await body<{ password: string }>(request);
  if (typeof data.password !== 'string' || !await equalSecret(data.password, env.HUB_PASSWORD)) throw new HttpError(401, '密码不正确');
  const token = crypto.randomUUID() + crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO devices(id, token_hash, expires_at) VALUES (?, ?, ?)').bind(deviceId, await digest(token), now + 90 * 86_400_000),
    env.DB.prepare('DELETE FROM login_attempts WHERE expires_at < ?').bind(now),
  ]);
  return json({ token, deviceId });
}

function validateContext(c: ProactiveContext, id: string) {
  assert(c && c.character?.id === id && c.chat?.characterId === id, '角色与聊天不匹配');
  assert(c.persona?.name && c.environment?.timezone && c.environment?.meals, '缺少人设或作息');
  try { zonedParts(Date.now(), c.environment.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
  assert(Array.isArray(c.history) && c.history.length <= 200 && c.history.every((m) => m.chatId === c.chat.id), '聊天上下文无效（最多 200 条）');
  assert(Array.isArray(c.rules) && c.rules.length <= 50 && Array.isArray(c.lorebooks) && Array.isArray(c.memories), '规则或世界书无效');
  assert(typeof c.character.proactive?.enabled === 'boolean' && Array.isArray(c.character.proactive.triggers), '主动消息设置无效');
  assert(Number.isFinite(c.busyUntil) && ['full', 'name-only', 'hidden'].includes(c.preview), '状态或通知预览无效');
  const times = [c.environment.wakeTime, c.environment.sleepTime, c.character.proactive.quietHours.start, c.character.proactive.quietHours.end,
    ...Object.values(c.environment.meals).flatMap((w) => [w.start, w.end])];
  assert(times.every((t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)), '作息时间须为 HH:mm');
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/health' && request.method === 'GET') return json({ ok: true });
  if (path === '/v1/auth/login' && request.method === 'POST') return login(request, env);
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, '需要登录');
  const device = await env.DB.prepare('SELECT id FROM devices WHERE token_hash = ? AND expires_at > ?').bind(await digest(token), Date.now()).first<{ id: string }>();
  if (!device) throw new HttpError(401, '登录已过期');

  if (path === '/v1/auth/session' && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run();
    return json({ ok: true });
  }

  if (path === '/v1/status' && request.method === 'GET') {
    const [enabled, lastCronAt, lastError, configured, channels, rhythmConfigured, lastRhythmError, memoryConfigured, lastMemoryError] = await Promise.all([
      getMeta(env, 'enabled', false), getMeta<number | null>(env, 'lastCronAt', null), getMeta<string | null>(env, 'lastError', null),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'proactive'").first(),
      env.DB.prepare('SELECT id, kind, label, last_ok_at AS lastOkAt FROM push_channels').all(),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'rhythm'").first(), getMeta<string | null>(env, 'lastRhythmError', null),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'consolidate'").first(), getMeta<string | null>(env, 'lastMemoryError', null),
    ]);
    return json({ enabled, lastCronAt, lastError, configured: !!configured, rhythmConfigured: !!rhythmConfigured, lastRhythmError,
      memoryConfigured: !!memoryConfigured, lastMemoryError, vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null, channels: channels.results });
  }
  if (path === '/v1/proactive/enabled' && request.method === 'PUT') {
    const { enabled } = await body<{ enabled: boolean }>(request);
    assert(typeof enabled === 'boolean', 'enabled 必须为布尔值');
    if (enabled) assert(await env.DB.prepare("SELECT id FROM secrets WHERE id = 'proactive'").first(), '请先上传主动消息 API');
    await setMeta(env, 'enabled', enabled);
    return json({ enabled });
  }
  if (path === '/v1/proactive/contexts' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT character_id AS id, revision FROM contexts').all();
    return json({ contexts: rows.results });
  }
  if (path.startsWith('/v1/proactive/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/proactive/contexts/'.length));
    if (request.method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM contexts WHERE character_id = ?').bind(id),
        env.DB.prepare("DELETE FROM touchpoints WHERE character_id = ? AND status = 'planned'").bind(id),
      ]);
      return json({ ok: true });
    }
    if (request.method === 'PUT') {
      const { context, revision } = await body<{ context: ProactiveContext; revision: number }>(request);
      validateContext(context, id);
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO contexts(character_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM contexts WHERE character_id = ?)
        ON CONFLICT(character_id) DO UPDATE SET revision = contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(context), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了角色上下文，请重新连接后同步');
      return json(updated);
    }
  }
  if (path === '/v1/rhythm/contexts' && request.method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT character_id AS id, revision FROM rhythm_contexts').all()).results });
  }
  if (path.startsWith('/v1/rhythm/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/rhythm/contexts/'.length));
    if (request.method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM rhythm_contexts WHERE character_id = ?').bind(id),
        env.DB.prepare('DELETE FROM rhythm_days WHERE character_id = ? AND data IS NULL').bind(id),
      ]);
      return json({ ok: true });
    }
    if (request.method === 'PUT') {
      const { context: c, revision } = await body<{ context: RhythmContext; revision: number }>(request);
      assert(c?.character?.id === id && c.character.card && typeof c.userName === 'string' && typeof c.promises === 'string', '节律角色无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少节律时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(c.settings?.mode === 'daily' && ['pick', 'new'].includes(c.settings.outfitMode)
        && ['schedule', 'meals', 'outfits'].every((k) => typeof c.settings.vary?.[k as keyof typeof c.settings.vary] === 'boolean'), '节律设置无效');
      assert(Array.isArray(c.template?.schedule) && c.template.schedule.length && c.template.meals && Array.isArray(c.template.wardrobe)
        && Array.isArray(c.world?.locations) && c.world.locations.length && Array.isArray(c.people), '缺少节律模板或世界');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO rhythm_contexts(character_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM rhythm_contexts WHERE character_id = ?)
        ON CONFLICT(character_id) DO UPDATE SET revision = rhythm_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE rhythm_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了节律设置，请重新连接后同步');
      return json(updated);
    }
  }
  if (path === '/v1/rhythm/days' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT d.character_id, d.date, d.data, d.last_error FROM rhythm_days d
      INNER JOIN rhythm_contexts c ON c.character_id = d.character_id ORDER BY d.date DESC`).all<{ character_id: string; date: string; data: string | null; last_error: string | null }>();
    return json({ days: rows.results.filter((d) => d.data).map((d) => JSON.parse(d.data!)),
      errors: rows.results.filter((d) => d.last_error).map((d) => ({ characterId: d.character_id, date: d.date, reason: d.last_error })) });
  }
  if (path === '/v1/memory/contexts' && request.method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT character_id AS id, revision FROM memory_contexts').all()).results });
  }
  if (path.startsWith('/v1/memory/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/memory/contexts/'.length));
    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM memory_contexts WHERE character_id = ?').bind(id).run();
      return json({ ok: true });
    }
    if (request.method === 'PUT') {
      const { context: c, revision } = await body<{ context: MemoryConsolidationContext; revision: number }>(request);
      assert(c?.characterId === id && c.character?.name && typeof c.userName === 'string', '记忆整理的角色无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(Array.isArray(c.mergeGroups) && c.mergeGroups.length <= 50 && Array.isArray(c.rollups) && c.rollups.length <= 50
        && Array.isArray(c.followups) && c.followups.length <= 200 && Array.isArray(c.newMemories) && c.newMemories.length <= 200
        && Array.isArray(c.profile?.lines), '记忆整理的内容无效');
      assert(c.preset && Array.isArray(c.preset.blocks), '缺少"整理"预设');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO memory_contexts(character_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM memory_contexts WHERE character_id = ?)
        ON CONFLICT(character_id) DO UPDATE SET revision = memory_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE memory_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了记忆整理的内容，请重新连接后同步');
      return json(updated);
    }
  }
  if (path === '/v1/memory/results' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    const rows = await env.DB.prepare('SELECT result, done_at FROM memory_jobs WHERE done_at > ? AND result IS NOT NULL ORDER BY done_at LIMIT 50')
      .bind(since).all<{ result: string; done_at: number }>();
    const errors = await env.DB.prepare('SELECT character_id, date, last_error FROM memory_jobs WHERE result IS NULL AND last_error IS NOT NULL').all<{ character_id: string; date: string; last_error: string }>();
    return json({
      results: rows.results.map((r) => ({ doneAt: r.done_at, result: JSON.parse(r.result) as MemoryJobResult })),
      errors: errors.results.map((e) => ({ characterId: e.character_id, date: e.date, reason: e.last_error })),
    });
  }
  if (['/v1/secrets/proactive', '/v1/secrets/rhythm', '/v1/secrets/consolidate'].includes(path) && request.method === 'PUT') {
    const role = path === '/v1/secrets/rhythm' ? 'rhythm' : path === '/v1/secrets/consolidate' ? 'consolidate' : 'proactive';
    const credentials = await body<ProactiveCredentials>(request);
    assert(Array.isArray(credentials.routes) && credentials.keys && Array.isArray(credentials.outputFilters), 'API 配置无效');
    const system = new AgentSystem({ config: { routes: () => credentials.routes, keyOf: (id) => credentials.keys[id] || null } });
    const chain = system.router.chain(role);
    assert(credentials.routes.every((r) => chain.includes(r.role)), '只接受该功能及其跟随的 API 配置');
    const status = system.status(role);
    assert(status.live, status.live ? '' : status.reason);
    const secret = await seal(env.KEK, credentials);
    await env.DB.prepare('INSERT INTO secrets(id, ciphertext, iv) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv')
      .bind(role, secret.ciphertext, secret.iv).run();
    return json({ ok: true });
  }
  if (path === '/v1/inbox' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    const [messages, points] = await Promise.all([
      env.DB.prepare('SELECT seq, character_id, data FROM messages WHERE seq > ? ORDER BY seq LIMIT 201').bind(since).all<{ seq: number; character_id: string; data: string }>(),
      env.DB.prepare('SELECT data, status, last_error, push_error FROM touchpoints WHERE due_at >= ?').bind(Date.now() - 3 * 86_400_000).all<{ data: string; status: string; last_error: string | null; push_error: string | null }>(),
    ]);
    const page = messages.results.slice(0, 200);
    return json({
      messages: page.map((m) => ({ seq: m.seq, characterId: m.character_id, message: JSON.parse(m.data) })),
      next: page.at(-1)?.seq ?? since, more: messages.results.length > 200,
      touchpoints: points.results.map((t) => ({ ...JSON.parse(t.data) as Touchpoint, status: t.status, lastError: t.last_error, pushError: t.push_error })),
    });
  }
  if (path === '/v1/push/subscribe' && request.method === 'POST') {
    const data = await body<{ kind: 'webpush' | 'webhook'; label: string; config: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } & Partial<Webhook> }>(request);
    assert(['webpush', 'webhook'].includes(data.kind) && typeof data.label === 'string' && data.label.length <= 100, '推送通道无效');
    assert(data.config && https(data.kind === 'webpush' ? data.config.endpoint ?? '' : data.config.url ?? ''), '推送地址必须为 HTTPS');
    if (data.kind === 'webpush') assert(data.config.keys?.p256dh && data.config.keys.auth, '缺少 Web Push 订阅密钥');
    else assert(['bark', 'ntfy', 'custom'].includes(data.config.preset ?? ''), '未知 webhook 类型');
    const id = await digest(data.kind + ':' + (data.config.endpoint ?? data.config.url));
    const sealed = await seal(env.KEK, data.config);
    await env.DB.prepare(`INSERT INTO push_channels(id, device_id, kind, label, ciphertext, iv) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, ciphertext = excluded.ciphertext, iv = excluded.iv`)
      .bind(id, device.id, data.kind, data.label, sealed.ciphertext, sealed.iv).run();
    return json({ id });
  }
  if (path.startsWith('/v1/push/channels/')) {
    const id = decodeURIComponent(path.slice('/v1/push/channels/'.length));
    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM push_channels WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    if (request.method === 'POST') {
      const ch = await env.DB.prepare('SELECT * FROM push_channels WHERE id = ?').bind(id).first<Channel>();
      if (!ch) throw new HttpError(404, '推送通道不存在');
      await sendChannel(env, ch, { title: 'AI 陪伴', body: '云端通知已接通，关闭 App 后也能接收', tag: `test:${Date.now()}`, route: '/me/proactive' });
      return json({ ok: true });
    }
  }
  throw new HttpError(404, '接口不存在');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = env.APP_ORIGIN.split(',').map((s) => s.trim());
    if (origin && !allowed.includes(origin)) return json({ error: '来源不允许' }, 403);
    let response: Response;
    try {
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await api(request, env);
    } catch (e) {
      response = e instanceof HttpError ? json({ error: e.message }, e.status)
        : e instanceof PushDeliveryError ? json({ error: e.message }, 502)
        : json({ error: 'Worker 操作失败，请检查云端配置和日志' }, 500);
    }
    if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return response;
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Scheduled execution is independent of HTTP requests and browser/service-worker lifetime.
    const jobs = await Promise.allSettled([runScheduled(env, controller.scheduledTime), runRhythmScheduled(env, controller.scheduledTime), runMemoryScheduled(env, controller.scheduledTime)]);
    const failure = jobs.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  },
} satisfies ExportedHandler<Env>;
