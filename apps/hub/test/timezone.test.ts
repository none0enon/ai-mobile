import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planTouchpoints, touchpointClock, type Touchpoint } from '@app/shared';
import { proactivePrompt } from '../src/generate.ts';
import { gate, planContext, runScheduled } from '../src/scheduler.ts';
import { context, fixture, message, NOW, saveContext } from './fixtures.ts';

function wakeContext(zone = 'UTC') {
  const c = context('alice', zone);
  c.character.proactive.triggers = ['wake-call'];
  c.character.proactive.allowCalls = true;
  c.environment.wakeTime = '12:00';
  return c;
}
const count = async (db: D1Database) => (await db.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>())!.n;
async function today(db: D1Database) {
  const row = await db.prepare("SELECT data FROM touchpoints WHERE id = '2026-11-11:alice:wake-call'").first<{ data: string }>();
  return JSON.parse(row!.data) as Touchpoint;
}

test('plans use the selected environment timezone across host zones, midnight and DST', () => {
  const original = process.env.TZ;
  try {
    for (const host of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = host;
      for (const [zone, instant, expectedDate, wakeTime, expectedDue] of [
        ['Asia/Shanghai', '2026-11-12T01:30:00Z', '2026-11-12', '07:30', '2026-11-11T23:30:00.000Z'],
        ['America/New_York', '2026-11-12T01:30:00Z', '2026-11-11', '07:30', '2026-11-11T12:30:00.000Z'],
        ['Asia/Kathmandu', '2026-11-12T20:30:00Z', '2026-11-13', '07:30', '2026-11-13T01:45:00.000Z'],
        ['America/New_York', '2026-03-08T12:00:00Z', '2026-03-08', '02:30', '2026-03-08T07:30:00.000Z'],
        ['America/New_York', '2026-11-01T12:00:00Z', '2026-11-01', '01:30', '2026-11-01T05:30:00.000Z'],
      ]) {
        const c = wakeContext(zone);
        c.environment.wakeTime = wakeTime!;
        const [point] = planTouchpoints({ character: c.character, rules: c.rules, env: c.environment, day: new Date(instant!) });
        assert.equal(point!.date, expectedDate, host);
        assert.equal(point!.timezone, zone);
        assert.equal(new Date(point!.dueAt).toISOString(), expectedDue, host);
        assert.equal(touchpointClock(point!, zone), wakeTime === '02:30' ? '03:30' : wakeTime);
      }
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('followups and quiet hours use the selected local day and clock', () => {
  const now = Date.parse('2026-11-12T20:30:00Z');
  const c = context('alice', 'Asia/Kathmandu');
  const points = planTouchpoints({ character: c.character, rules: c.rules, env: c.environment, day: new Date(now),
    followups: [{ id: 'today', content: 'today', dueAt: now }, { id: 'yesterday', content: 'yesterday', dueAt: now - 3 * 3_600_000 }] });
  assert.equal(points.length, 1);
  assert.equal(points[0]!.date, '2026-11-13');
  assert.equal(points[0]!.dueAt, now);
  c.character.proactive.quietHours = { start: '23:00', end: '07:00' };
  assert.equal(gate(c, points[0]!, now), '勿扰时段');
});

test('proactive instructions, environment and preset macros share the selected timezone even in a host DST gap', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const now = Date.parse('2026-03-07T18:30:00Z'); // Shanghai 02:30 on LA's spring-forward date.
    const c = context('alice', 'Asia/Shanghai');
    c.character.card.description += '\nClock [{{isodate}}|{{time}}|{{weekday}}]';
    const [point] = planTouchpoints({ character: c.character, rules: c.rules, env: c.environment, day: new Date(now),
      followups: [{ id: 'now', content: '{{time}} followup', dueAt: now }] });
    const text = JSON.stringify(proactivePrompt(c, point!, now, 'test').messages);
    assert.match(text, /现在是 2026-03-08 02:30（Asia\/Shanghai）/);
    assert.match(text, /2026-03-08 周日 02:30/);
    assert.match(text, /Clock \[2026-03-08\|02:30\|星期日\]/);
    assert.match(text, /02:30 followup/);
    for (const block of c.preset!.blocks) if (['environment', 'proactive'].includes(block.identifier)) block.enabled = false;
    assert.match(JSON.stringify(proactivePrompt(c, point!, now, 'test').messages), /现在是 2026-03-08 02:30（Asia\/Shanghai）/);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

for (const legacy of [false, true]) {
  test(`timezone changes move overdue work to the new clock and preserve completed messages${legacy ? ' (legacy plans)' : ''}`, async (t) => {
    const { env, DB } = await fixture(t);
    const c = wakeContext();
    await saveContext(env, c);
    const generate = async (ctx: typeof c, _keys: unknown, point: Touchpoint, now: number) => message(ctx, point, now);
    await runScheduled(env, NOW - 300_000, generate);
    if (legacy) await DB.prepare("UPDATE touchpoints SET data = json_remove(data, '$.timezone')").run();
    c.environment.timezone = 'America/New_York';
    await saveContext(env, c);
    await runScheduled(env, NOW + 300_000, generate);
    assert.equal(await count(DB), 0);
    assert.equal((await today(DB)).dueAt, NOW + 5 * 3_600_000);
    assert.equal((await today(DB)).timezone, c.environment.timezone);
    assert.equal((await today(DB)).status, 'planned');
    await runScheduled(env, NOW + 5 * 3_600_000, generate);
    const completed = await today(DB);
    assert.equal(await count(DB), 1);
    c.environment.timezone = 'UTC';
    await saveContext(env, c);
    await runScheduled(env, NOW + 5 * 3_600_000 + 300_000, generate);
    assert.equal(await count(DB), 1);
    assert.deepEqual(await today(DB), completed);
  });
}

test('moving to an earlier sending time catches up once using the new timezone', async (t) => {
  const { env, DB } = await fixture(t);
  const c = wakeContext('America/New_York');
  await saveContext(env, c);
  const generate = async (ctx: typeof c, _keys: unknown, point: Touchpoint, now: number) => message(ctx, point, now);
  await runScheduled(env, NOW, generate);
  assert.equal(await count(DB), 0);
  c.environment.timezone = 'UTC';
  await saveContext(env, c);
  await runScheduled(env, NOW + 300_000, generate);
  await runScheduled(env, NOW + 600_000, generate);
  assert.equal(await count(DB), 1);
  assert.equal((await today(DB)).dueAt, NOW);
});

test('a timezone change during generation discards stale output and uses the new sending time', async (t) => {
  const { env, DB } = await fixture(t);
  const c = wakeContext();
  await saveContext(env, c);
  let calls = 0;
  const generate = async (ctx: typeof c, _keys: unknown, point: Touchpoint, now: number) => {
    if (++calls === 1) {
      c.environment.timezone = 'America/New_York';
      await saveContext(env, c);
    }
    return message(ctx, point, now);
  };
  await runScheduled(env, NOW, generate);
  assert.equal(await count(DB), 0);
  await runScheduled(env, NOW + 300_000, generate);
  assert.equal(calls, 1);
  await runScheduled(env, NOW + 5 * 3_600_000, generate);
  assert.equal(calls, 2);
  assert.equal(await count(DB), 1);
  assert.equal((await today(DB)).timezone, c.environment.timezone);
});

test('an older context snapshot cannot overwrite a plan after a timezone update', async (t) => {
  const { env, DB } = await fixture(t);
  const c = wakeContext();
  await saveContext(env, c);
  const old = (await DB.prepare('SELECT * FROM contexts').first<{ character_id: string; data: string; revision: number; updated_at: number }>())!;
  c.environment.timezone = 'America/New_York';
  await saveContext(env, c);
  await runScheduled(env, NOW, async (ctx, _keys, point, now) => message(ctx, point, now));
  await planContext(env, old, NOW);
  assert.equal((await today(DB)).dueAt, NOW + 5 * 3_600_000);
  assert.equal((await today(DB)).timezone, c.environment.timezone);
});
