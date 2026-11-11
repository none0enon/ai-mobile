import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planTouchpoints, zonedInstant, zonedDateKey } from '@app/shared';
import { gate, runScheduled } from '../src/scheduler.ts';
import { generateMessage, proactivePrompt } from '../src/generate.ts';
import { seal } from '../src/crypto.ts';
import { context, credentials, fixture, message, NOW, saveContext, saveCredentials } from './fixtures.ts';

const count = async (db: D1Database) => (await db.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>())!.n;

test('no browser: Cron generates, stores and sends; repeated/overlapping Cron produces one message', async (t) => {
  const { env, DB } = await fixture(t);
  const c = context(); await saveContext(env, c);
  const hook = await seal(env.KEK, { preset: 'custom', url: 'https://push.test/hook' });
  await DB.prepare("INSERT INTO push_channels(id, device_id, kind, label, ciphertext, iv) VALUES ('hook', 'device', 'webhook', 'hook', ?, ?)").bind(hook.ciphertext, hook.iv).run();
  let notifications = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://push.test/hook');
    const payload = JSON.parse(init.body as string);
    assert.match(payload.url, /#\/chat\/chat-alice$/);
    notifications++; return Response.json({ ok: true });
  });
  let generated = 0;
  const generate: typeof generateMessage = async (ctx, _keys, point, now) => { generated++; return message(ctx, point, now); };
  await Promise.all([runScheduled(env, NOW, generate), runScheduled(env, NOW, generate)]);
  await runScheduled(env, NOW + 300_000, generate);
  assert.equal(generated, 1); assert.equal(await count(DB), 1); assert.equal(notifications, 1);
  assert.equal((await DB.prepare("SELECT status FROM touchpoints WHERE rule_id = 'followup'").first<{ status: string }>())?.status, 'delivered');
});

test('roles execute concurrently: a slow role does not hold up another role', async (t) => {
  const { env, DB } = await fixture(t);
  await Promise.all([saveContext(env, context('slow')), saveContext(env, context('fast'))]);
  const hook = await seal(env.KEK, { preset: 'custom', url: 'https://push.test/hook' });
  await DB.prepare("INSERT INTO push_channels(id, device_id, kind, label, ciphertext, iv) VALUES ('hook', 'device', 'webhook', 'hook', ?, ?)").bind(hook.ciphertext, hook.iv).run();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let fastDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => { fastDelivered = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (JSON.parse(init.body as string).url.endsWith('#/chat/chat-fast')) fastDelivered();
    return Response.json({ ok: true });
  });
  const run = runScheduled(env, NOW, async (ctx, _keys, point, now) => {
    if (ctx.character.id === 'slow') await blocked;
    return message(ctx, point, now);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([delivered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fast notification was held up by slow role')), 3000); })]);
  } finally { clearTimeout(timer); release(); await run; }
  assert.equal(await count(DB), 2);
});

test('days with App closed: Cron creates new daily plans from the saved IANA zone', async (t) => {
  const { env, DB } = await fixture(t);
  const c = context('night', 'Asia/Shanghai');
  c.character.proactive.triggers = ['morning'];
  await saveContext(env, c);
  let generated = 0;
  for (let day = 0; day < 3; day++) {
    const date = `2026-11-${11 + day}`;
    const now = zonedInstant(date, 8 * 60, c.environment.timezone);
    await runScheduled(env, now, async (ctx, _keys, point, when) => { generated++; return message(ctx, point, when); });
  }
  assert.equal(generated, 3); assert.equal(await count(DB), 3);
});

test('model error retries on a later Cron; push failure retries saved message without regenerating', async (t) => {
  const { env, DB } = await fixture(t);
  await saveContext(env, context());
  let attempts = 0;
  const generate: typeof generateMessage = async (ctx, _keys, point, now) => {
    if (++attempts === 1) throw new Error('temporary provider outage');
    return message(ctx, point, now);
  };
  await runScheduled(env, NOW, generate);
  assert.equal(await count(DB), 0);
  await runScheduled(env, NOW + 300_000, generate);
  await runScheduled(env, NOW + 600_000, generate);
  assert.equal(await count(DB), 1); assert.equal(attempts, 2);
  assert.match((await DB.prepare("SELECT push_error FROM touchpoints WHERE rule_id='followup'").first<{ push_error: string }>())!.push_error, /通知通道/);
});

test('stopping or changing a role during model generation suppresses stale output', async (t) => {
  const { env, DB } = await fixture(t);
  const c = context(); await saveContext(env, c);
  await runScheduled(env, NOW, async (ctx, _keys, point, now) => {
    c.character.proactive.enabled = false; await saveContext(env, c);
    return message(ctx, point, now);
  });
  assert.equal(await count(DB), 0);
});

test('daily token budget is reserved atomically across concurrent roles', async (t) => {
  const { env, DB } = await fixture(t);
  const a = context('one'); const b = context('two');
  const request = proactivePrompt(a, planTouchpoints({ character: a.character, rules: a.rules, env: a.environment, day: new Date(NOW), timeZone: 'UTC', followups: [{ id: 'due', content: 'The interview result', dueAt: NOW }] })[0]!, NOW, 'test');
  const { estimateTokens } = await import('@app/shared');
  const keys = credentials(); keys.routes[0]!.dailyTokenBudget = estimateTokens(JSON.stringify(request.messages)) + (request.maxTokens ?? 600) + 20;
  await saveCredentials(env, keys);
  await Promise.all([saveContext(env, a), saveContext(env, b)]);
  let finish!: () => void;
  const delay = new Promise<void>((resolve) => { finish = resolve; });
  const timer = setTimeout(() => finish(), 300);
  await runScheduled(env, NOW, async (ctx, _keys, point, now) => { await delay; return message(ctx, point, now); });
  clearTimeout(timer);
  assert.equal(await count(DB), 1);
  assert.equal((await DB.prepare('SELECT reserved FROM usage').first<{ reserved: number }>())!.reserved, 0);
});

test('runtime gates use the user timezone, recent chat, busy state, quiet hours and unanswered backoff', () => {
  const c = context();
  const point = planTouchpoints({ character: c.character, rules: c.rules, env: c.environment, day: new Date(NOW), timeZone: 'UTC', followups: [{ id: 'due', content: '', dueAt: NOW }] })[0]!;
  assert.equal(gate(c, point, NOW), null);
  c.character.proactive.quietHours = { start: '11:00', end: '13:00' };
  assert.match(gate(c, point, NOW)!, /勿扰/);
  c.character.proactive.quietHours = { start: '00:00', end: '00:00' };
  c.busyUntil = NOW + 60_000; assert.match(gate(c, point, NOW)!, /学习/); c.busyUntil = 0;
  c.history = [{ ...message(c, point, NOW - 60_000), role: 'user', proactive: false }];
  assert.match(gate(c, point, NOW)!, /20 分钟/);
  c.history = [message(c, point, NOW - 60_000), { ...message(c, point, NOW - 120_000), id: 'other' }];
  assert.match(gate(c, point, NOW)!, /退避/);
});

test('planner handles UTC boundaries, midnight and DST without a fixed 24-hour assumption', () => {
  assert.equal(new Date(zonedInstant('2026-11-11', 7 * 60 + 30, 'Asia/Shanghai')).toISOString(), '2026-11-10T23:30:00.000Z');
  assert.equal(new Date(zonedInstant('2026-03-08', 150, 'America/New_York')).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.equal(new Date(zonedInstant('2026-11-01', 90, 'America/New_York')).toISOString(), '2026-11-01T05:30:00.000Z');
  const c = context('late', 'America/New_York'); c.character.proactive.triggers = ['bedtime']; c.environment.sleepTime = '00:30';
  const points = planTouchpoints({ character: c.character, rules: c.rules, env: c.environment, day: new Date('2026-03-07T12:00Z'), timeZone: c.environment.timezone });
  assert.equal(zonedDateKey(points[0]!.dueAt, c.environment.timezone), '2026-03-08');
});

test('real shared model adapter assembles role, preset, memory and fresh local time only at firing', async (t) => {
  const c = context();
  const point = planTouchpoints({ character: c.character, rules: c.rules, env: c.environment, day: new Date(NOW), timeZone: 'UTC', followups: [{ id: 'due', content: 'The interview result', dueAt: NOW }] })[0]!;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const req = JSON.parse(init.body as string);
    assert.match(JSON.stringify(req.messages), /Role card for alice/);
    assert.match(JSON.stringify(req.messages), /The interview result/);
    assert.match(JSON.stringify(req.messages), /2026-11-11/);
    calls++;
    return Response.json({ choices: [{ message: { role: 'assistant', content: '[expr:smile]面试怎么样？' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  });
  const msg = await generateMessage(c, credentials(), point, NOW);
  assert.equal(msg.text, '面试怎么样？'); assert.equal(msg.expression, 'smile'); assert.equal(msg.meta.tokens, 120); assert.equal(calls, 1);
});
