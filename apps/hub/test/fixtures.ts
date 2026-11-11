import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { characterFromCard, parseCardJson, parsePresetFile, DEFAULT_PROACTIVE_RULES,
  type Message, type ProactiveContext, type ProactiveCredentials, type Touchpoint } from '@app/shared';
import { seal } from '../src/crypto.ts';
import { setMeta } from '../src/scheduler.ts';
import type { Env } from '../src/env.ts';

export const NOW = Date.parse('2026-11-11T12:00:00Z');
export function context(id = 'alice', zone = 'UTC'): ProactiveContext {
  const character = characterFromCard(parseCardJson({ name: id, description: `Role card for ${id}` }), { id, now: NOW - 86_400_000, lorebookIds: [], presetId: 'preset' });
  character.proactive = { ...character.proactive, triggers: ['followup'], quietHours: { start: '00:00', end: '00:00' } };
  const parsed = parsePresetFile(JSON.parse(readFileSync(new URL('../../web/src/presets/proactive.json', import.meta.url), 'utf8')));
  return {
    character,
    chat: { id: `chat-${id}`, characterId: id, createdAt: 0, updatedAt: 0, personaId: null, title: id, mode: 'im', currentScene: null, togetherAt: null, togetherMode: null,
      summaryUntilMessageId: null, pinned: false, lastMessageAt: 0, background: null },
    persona: { id: 'user', name: 'Reader', description: 'Persona context', avatar: null, createdAt: 0, updatedAt: 0, isDefault: true },
    preset: { ...parsed, id: 'preset', createdAt: 0, updatedAt: 0 }, lorebooks: [], history: [],
    memories: [{ id: 'due', content: 'The interview result', type: 'followup', dueAt: NOW }],
    environment: { timezone: zone, city: '', weatherProvider: 'open-meteo', useLocation: false, wakeTime: '07:30', sleepTime: '23:30',
      meals: { breakfast: { start: '07:30', end: '09:30' }, lunch: { start: '11:30', end: '13:30' }, dinner: { start: '17:30', end: '19:30' } } },
    rules: DEFAULT_PROACTIVE_RULES, busyUntil: 0, preview: 'full',
  };
}
export function credentials(): ProactiveCredentials {
  return { routes: [{ role: 'proactive', api: { channel: 'openai', baseUrl: 'https://model.test/v1', model: 'test', models: [] }, backup: null, runsOn: 'hub' }],
    keys: { 'api:proactive': 'test-key' }, outputFilters: [] };
}
export function message(c: ProactiveContext, t: Touchpoint, now: number): Message {
  return { id: `proactive:${t.id}`, chatId: c.chat.id, role: 'assistant', text: 'Hello from the cloud', parts: [{ type: 'text', text: 'Hello from the cloud' }],
    createdAt: now, updatedAt: now, expression: null, swipes: [], swipeIndex: 0, proactive: true, read: false, meta: { tokens: 20 } };
}
export async function fixture(t: { after(fn: () => Promise<void>): void }, bundled = false) {
  const mf = new Miniflare(convertV4MiniflareOptions({ unsafeTriggerHandlers: true, workers: [{ name: 'hub', modules: true, compatibilityDate: '2026-11-11',
    ...(bundled ? { scriptPath: new URL('../dist/index.js', import.meta.url).pathname } : { script: 'export default { fetch() { return new Response("ok"); } }' }),
    d1Databases: { DB: 'test-db' },
    bindings: { HUB_PASSWORD: 'test-password', KEK: btoa('k'.repeat(32)), APP_ORIGIN: 'https://app.test', APP_URL: 'https://app.test/ai-mobile/' },
  }] }));
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database('DB') as unknown as D1Database;
  const schema = readFileSync(new URL('../migrations/0001_proactive.sql', import.meta.url), 'utf8');
  await DB.batch(schema.split(';').map((s) => s.trim()).filter(Boolean).map((s) => DB.prepare(s)));
  const env: Env = { DB, HUB_PASSWORD: 'test-password', KEK: btoa('k'.repeat(32)), APP_ORIGIN: 'https://app.test', APP_URL: 'https://app.test/ai-mobile/' };
  await setMeta(env, 'enabled', true);
  await saveCredentials(env, credentials());
  return { env, mf, DB };
}
export async function saveCredentials(env: Env, data: ProactiveCredentials) {
  const encrypted = await seal(env.KEK, data);
  await env.DB.prepare("INSERT OR REPLACE INTO secrets(id, ciphertext, iv) VALUES ('proactive', ?, ?)").bind(encrypted.ciphertext, encrypted.iv).run();
}
export async function saveContext(env: Env, c: ProactiveContext) {
  await env.DB.prepare('INSERT INTO contexts(character_id, revision, data, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(character_id) DO UPDATE SET data=excluded.data, revision=contexts.revision+1')
    .bind(c.character.id, JSON.stringify(c), NOW).run();
}
