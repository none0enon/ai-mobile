import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { CorePaths } from 'miniflare';
import { DEFAULT_RHYTHM_SETTINGS, dayFromTemplate, estimateTokens, parsePresetFile, rhythmDate, templateFromWorld, worldOf, zonedInstant,
  type ProactiveCredentials, type RhythmContext, type RhythmDay } from '@app/shared';
import { generateRhythm, rhythmRequest, runRhythmScheduled } from '../src/rhythm.ts';
import { seal } from '../src/crypto.ts';
import { setMeta } from '../src/scheduler.ts';
import { context, fixture } from './fixtures.ts';

function rhythmContext(id = 'alice', timezone = 'America/Indiana/Indianapolis'): RhythmContext {
  const c = context(id);
  const world = worldOf('suwan');
  const preset = parsePresetFile(JSON.parse(readFileSync(new URL('../../web/src/presets/rhythm.json', import.meta.url), 'utf8')));
  return { character: c.character, userName: c.persona.name, timezone, settings: structuredClone({ ...DEFAULT_RHYTHM_SETTINGS, mode: 'daily' }),
    template: templateFromWorld(world), world, people: [], preset: { ...preset, id: 'rhythm', createdAt: 0, updatedAt: 0 }, promises: '约好一起去看书' };
}
function credentials(): ProactiveCredentials {
  return { routes: [{ role: 'rhythm', follow: 'main', api: null, backup: null, runsOn: 'hub' },
    { role: 'main', api: { channel: 'openai', baseUrl: 'https://model.test/v1', model: 'rhythm-model', models: [] }, backup: null, runsOn: 'device' }],
  keys: { 'api:main': 'rhythm-test-key' }, outputFilters: [] };
}
async function saveContext(env: Awaited<ReturnType<typeof fixture>>['env'], c: RhythmContext) {
  await env.DB.prepare(`INSERT INTO rhythm_contexts(character_id, revision, data, updated_at) VALUES (?, 1, ?, 0)
    ON CONFLICT(character_id) DO UPDATE SET revision = revision + 1, data = excluded.data`).bind(c.character.id, JSON.stringify(c)).run();
}
async function setup(t: Parameters<typeof fixture>[0], contexts = [rhythmContext()]) {
  const f = await fixture(t);
  const secret = await seal(f.env.KEK, credentials());
  await f.DB.prepare("INSERT INTO secrets(id, ciphertext, iv) VALUES ('rhythm', ?, ?)").bind(secret.ciphertext, secret.iv).run();
  await Promise.all([setMeta(f.env, 'enabled', false), ...contexts.map((c) => saveContext(f.env, c))]);
  return f;
}
const generated: typeof generateRhythm = async (c, _keys, date, _recent, now) => ({ day: { ...dayFromTemplate(c.character.id, date, c.template), source: 'model', at: now, model: 'test' }, tokens: 20 });
const count = async (db: D1Database) => (await db.prepare('SELECT COUNT(*) AS n FROM rhythm_days WHERE data IS NOT NULL').first<{ n: number }>())!.n;

test('4 AM calendar boundary respects user timezone, fractional offsets and both DST transitions', () => {
  for (const zone of ['America/New_York', 'Asia/Shanghai', 'Asia/Kathmandu', 'Pacific/Auckland']) {
    for (const date of ['2026-03-08', '2026-11-01', '2026-12-31']) {
      const start = zonedInstant(date, 240, zone);
      assert.equal(rhythmDate(new Date(start), zone), date);
      assert.notEqual(rhythmDate(new Date(start - 1), zone), date);
    }
  }
  assert.equal(rhythmDate(new Date('2026-11-12T19:59:59Z'), 'Asia/Shanghai'), '2026-11-12');
  assert.equal(rhythmDate(new Date('2026-11-12T20:00:00Z'), 'Asia/Shanghai'), '2026-11-13');
});

test('PWA closed for days: each 4 AM generates once, with proactive disabled and no notification channel', async (t) => {
  const c = rhythmContext();
  const { env, DB } = await setup(t, [c]);
  let calls = 0;
  const generate: typeof generateRhythm = async (...args) => {
    calls++;
    assert.equal(args[3].length, Math.min(calls - 1, 3));
    return generated(...args);
  };
  for (const date of ['2026-11-11', '2026-11-12', '2026-11-13']) {
    const now = zonedInstant(date, 240, c.timezone);
    await Promise.all([runRhythmScheduled(env, now, generate), runRhythmScheduled(env, now, generate)]);
    await runRhythmScheduled(env, now + 300_000, generate);
    await runRhythmScheduled(env, zonedInstant(date, 24 * 60 + 239, c.timezone), generate);
  }
  assert.equal(calls, 3);
  assert.equal(await count(DB), 3);
});

test('daily rhythm characters run concurrently: slow role cannot hold another result', async (t) => {
  const { env, DB } = await setup(t, [rhythmContext('slow'), rhythmContext('fast')]);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let fast!: () => void;
  const arrived = new Promise<void>((resolve) => { fast = resolve; });
  const run = runRhythmScheduled(env, zonedInstant('2026-11-12', 240, 'America/Indiana/Indianapolis'), async (...args) => {
    if (args[0].character.id === 'slow') await blocked;
    else fast();
    return generated(...args);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([arrived, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fast role was blocked')), 3000); })]);
    // Allow the fast role's D1 commit to settle while slow is still blocked.
    for (let i = 0; i < 100 && await count(DB) === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await count(DB), 1);
  } finally { clearTimeout(timer); release(); await run; }
  assert.equal(await count(DB), 2);
});

test('failed generation retries independently; ready days are reused and expired claims recover', async (t) => {
  const { env, DB } = await setup(t, [rhythmContext('fails'), rhythmContext('ok')]);
  const now = zonedInstant('2026-11-12', 240, 'America/Indiana/Indianapolis');
  let attempts = 0;
  const generate: typeof generateRhythm = async (...args) => {
    if (args[0].character.id === 'fails' && ++attempts === 1) throw new Error('provider secret must not be stored');
    return generated(...args);
  };
  await runRhythmScheduled(env, now, generate);
  assert.equal(await count(DB), 1);
  const error = await DB.prepare("SELECT last_error FROM rhythm_days WHERE character_id = 'fails'").first<{ last_error: string }>();
  assert.match(error!.last_error, /自动重试/);
  assert.doesNotMatch(error!.last_error, /secret/);
  await runRhythmScheduled(env, now + 60_000, generate);
  assert.equal(attempts, 1);
  await runRhythmScheduled(env, now + 300_000, generate);
  assert.equal(await count(DB), 2);
  assert.equal(attempts, 2);
  await DB.prepare("INSERT INTO rhythm_days(character_id, date, lease, lease_until) VALUES ('ok', '2026-11-13', 'evicted', ?)").bind(now + 86_400_000 - 1).run();
  await runRhythmScheduled(env, now + 86_400_000, generate);
  assert.equal(await count(DB), 4);
});

test('context edits and deletion during generation prevent a stale plan from being committed', async (t) => {
  const c = rhythmContext();
  const { env, DB } = await setup(t, [c]);
  const now = zonedInstant('2026-11-12', 240, c.timezone);
  await runRhythmScheduled(env, now, async (...args) => {
    c.template.task = 'new task'; await saveContext(env, c);
    return generated(...args);
  });
  assert.equal(await count(DB), 0);
  await runRhythmScheduled(env, now + 300_000, generated);
  assert.equal(await count(DB), 1);
  await runRhythmScheduled(env, now + 86_400_000, async (...args) => {
    await DB.prepare('DELETE FROM rhythm_contexts').run();
    return generated(...args);
  });
  assert.equal(await count(DB), 1);
});

test('fixed rhythms never call the model', async (t) => {
  const c = rhythmContext(); c.settings.mode = 'fixed';
  const { env, DB } = await setup(t, [c]);
  let calls = 0;
  await runRhythmScheduled(env, Date.now(), async (...args) => { calls++; return generated(...args); });
  assert.equal(calls, 0);
  assert.equal(await count(DB), 0);
});

test('configured rhythm budget is shared atomically across concurrent characters', async (t) => {
  const a = rhythmContext('one'); const b = rhythmContext('two');
  const { env, DB } = await setup(t, [a, b]);
  const request = rhythmRequest(a, '2026-11-12', []);
  const keys = credentials();
  keys.routes[0]!.dailyTokenBudget = estimateTokens(JSON.stringify(request.messages)) + (request.maxTokens ?? 0) + 20;
  const secret = await seal(env.KEK, keys);
  await DB.prepare("UPDATE secrets SET ciphertext = ?, iv = ? WHERE id = 'rhythm'").bind(secret.ciphertext, secret.iv).run();
  let release!: () => void;
  const pending = new Promise<void>((r) => { release = r; });
  const timer = setTimeout(release, 300);
  try {
    await runRhythmScheduled(env, zonedInstant('2026-11-12', 240, a.timezone), async (...args) => { await pending; return generated(...args); });
  } finally { clearTimeout(timer); release(); }
  assert.equal(await count(DB), 1);
  assert.equal((await DB.prepare("SELECT reserved FROM usage WHERE date = 'rhythm:2026-11-12'").first<{ reserved: number }>())!.reserved, 0);
});

test('real rhythm adapter uses selected preset, fresh date, recent days and shared schedule/outfit checks', async (t) => {
  const c = rhythmContext();
  const home = c.world.locations[0]!.id;
  c.template.schedule = [{ from: '00:00', to: '12:00', locationId: home, status: '固定工作', fixed: true }, { from: '12:00', to: '24:00', locationId: home, status: '休息' }];
  c.template.wardrobe = [{ id: 'shirt', kind: 'daily', name: '衬衫', tags: 'white shirt' }];
  c.settings.vary.meals = false;
  const previous = dayFromTemplate('alice', '2026-11-11', c.template);
  previous.meals.dinner = '昨天的面条';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer rhythm-test-key');
    const body = JSON.parse(init.body as string);
    const messages = JSON.stringify(body.messages);
    assert.match(messages, /2026-11-12/); assert.match(messages, /昨天的面条/);
    assert.match(messages, /约好一起去看书/); assert.match(messages, /Role card for alice/);
    return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
      schedule: [{ from: '08:00', to: '20:00', at: 'unknown location', status: '散步' }],
      meals: { dinner: '模型想换的晚饭' }, outfits: { daily: { name: '不存在的衣服', tags: 'alien suit' } }, task: '今日任务', events: ['小事'],
    }) }, finish_reason: 'stop' }] });
  });
  const { day } = await generateRhythm(c, credentials(), '2026-11-12', [previous], 123);
  assert.equal(day.at, 123); assert.equal(day.date, '2026-11-12');
  assert.deepEqual(day.schedule[0], c.template.schedule[0]);
  assert.equal(day.schedule.at(-1)?.to, '24:00');
  assert.ok(day.schedule.every((s) => c.world.locations.some((l) => l.id === s.locationId)));
  assert.equal(day.outfits.daily?.tags, 'white shirt');
  assert.equal(day.meals.dinner, c.template.meals.dinner);
  assert.ok(day.fixes?.length);
});

test('bundled Worker: upload once, close PWA, Cron generates and authenticated sync returns persisted rhythms', async (t) => {
  let calls = 0;
  const { mf, DB } = await fixture(t, true, { outboundService: async () => {
    calls++;
    return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ task: '云端安排的今天' }) }, finish_reason: 'stop' }] });
  } });
  const login = await mf.dispatchFetch('https://hub.test/v1/auth/login', { method: 'POST', body: JSON.stringify({ password: 'test-password' }) });
  const { token } = await login.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const put = (path: string, value: unknown) => mf.dispatchFetch(`https://hub.test${path}`, { method: 'PUT', headers, body: JSON.stringify(value) });
  const c = rhythmContext('alice', 'Asia/Shanghai');
  assert.equal((await put('/v1/proactive/enabled', { enabled: false })).status, 200);
  assert.equal((await put('/v1/secrets/rhythm', credentials())).status, 200);
  const uploaded = await put('/v1/rhythm/contexts/alice', { context: c, revision: 0 });
  assert.equal(uploaded.status, 200, await uploaded.text());
  assert.equal((await put('/v1/rhythm/contexts/alice', { context: c, revision: 0 })).status, 409);
  assert.equal((await put('/v1/rhythm/contexts/bad', { context: { ...c, character: { ...c.character, id: 'bad' }, timezone: 'Invalid/Zone' }, revision: 0 })).status, 400);
  for (const date of ['2026-11-12', '2026-11-13']) {
    const time = zonedInstant(date, 240, c.timezone);
    const trigger = await mf.dispatchFetch(`https://hub.test${CorePaths.SCHEDULED}?time=${time}&cron=${encodeURIComponent('*/5 * * * *')}`);
    assert.equal(trigger.status, 200, await trigger.text());
  }
  assert.equal(calls, 2);
  assert.equal((await mf.dispatchFetch('https://hub.test/v1/rhythm/days')).status, 401);
  const synced = await (await mf.dispatchFetch('https://hub.test/v1/rhythm/days', { headers })).json() as { days: RhythmDay[]; errors: unknown[] };
  assert.deepEqual(synced.days.map((d) => d.date), ['2026-11-13', '2026-11-12']);
  assert.equal(synced.days[0]!.task, '云端安排的今天'); assert.deepEqual(synced.errors, []);
  assert.equal((await mf.dispatchFetch('https://hub.test/v1/secrets/rhythm', { headers })).status, 404);
  const secret = await DB.prepare("SELECT ciphertext FROM secrets WHERE id = 'rhythm'").first<{ ciphertext: string }>();
  assert.ok(secret && !secret.ciphertext.includes('rhythm-test-key'));
  assert.equal((await mf.dispatchFetch('https://hub.test/v1/rhythm/contexts/alice', { method: 'DELETE', headers })).status, 200);
  await mf.dispatchFetch(`https://hub.test${CorePaths.SCHEDULED}?time=${zonedInstant('2026-11-14', 240, c.timezone)}`);
  assert.equal(calls, 2);
});
