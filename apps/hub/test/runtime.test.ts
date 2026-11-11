import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CorePaths } from 'miniflare';
import { context, fixture, NOW, saveContext } from './fixtures.ts';

// This uses the actual bundled Worker in workerd, with a real local D1 binding.
test('bundled Worker: authenticated API and scheduled event work with no app client', async (t) => {
  const { mf, env, DB } = await fixture(t, true);
  const c = context(); c.character.proactive.triggers = ['wake-call']; c.character.proactive.allowCalls = true; c.environment.wakeTime = '12:00';
  await saveContext(env, c);
  assert.equal((await mf.dispatchFetch('https://hub.test/v1/inbox')).status, 401);
  assert.equal((await mf.dispatchFetch('https://hub.test/v1/status', { headers: { Origin: 'https://wrong.test' } })).status, 403);
  const login = await mf.dispatchFetch('https://hub.test/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' }, body: JSON.stringify({ password: env.HUB_PASSWORD }) });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('Access-Control-Allow-Origin'), 'https://app.test');
  const { token } = await login.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}` };
  const trigger = await mf.dispatchFetch(`https://hub.test${CorePaths.SCHEDULED}?time=${NOW}&cron=${encodeURIComponent('*/5 * * * *')}`);
  assert.equal(trigger.status, 200, await trigger.text());
  const inbox = await (await mf.dispatchFetch('https://hub.test/v1/inbox?since=0', { headers })).json() as { messages: { message: { id: string; parts: { type: string }[] } }[]; next: number };
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0]!.message.parts[0]!.type, 'call-log');
  const again = await (await mf.dispatchFetch(`https://hub.test/v1/inbox?since=${inbox.next}`, { headers })).json() as { messages: unknown[] };
  assert.deepEqual(again.messages, []);
  assert.equal((await mf.dispatchFetch('https://hub.test/v1/secrets/proactive', { headers })).status, 404);
  const stored = await DB.prepare("SELECT ciphertext FROM secrets WHERE id='proactive'").first<{ ciphertext: string }>();
  assert.ok(stored && !stored.ciphertext.includes('test-key'));
  const conflict = await mf.dispatchFetch('https://hub.test/v1/proactive/contexts/alice', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ context: c, revision: 0 }) });
  assert.equal(conflict.status, 409);
});

test('service worker receives push with zero windows, then opens the exact chat under the PWA scope', async () => {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: { data: { route: string }; tag: string } }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (name: string, handler: (event: unknown) => void) => { listeners[name] = handler; },
    registration: { scope: 'https://app.test/ai-mobile/', showNotification: async (title: string, options: typeof shown[number]['options']) => { shown.push({ title, options }); } },
    clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } },
  };
  vm.runInNewContext(readFileSync(new URL('../../web/public/sw.js', import.meta.url), 'utf8'), { self, URL });
  let work: Promise<unknown> = Promise.resolve();
  const waitUntil = (p: Promise<unknown>) => { work = p; };
  listeners.push!({ data: { json: () => ({ title: 'Alice', body: 'Hello', route: '/chat/chat-alice', tag: 'proactive:stable-id' }) }, waitUntil });
  await work;
  assert.equal(shown[0]?.title, 'Alice'); assert.equal(shown[0]?.options.tag, 'proactive:stable-id');
  listeners.notificationclick!({ notification: { close() {}, data: shown[0]!.options.data }, waitUntil });
  await work;
  assert.deepEqual(opened, ['https://app.test/ai-mobile/#/chat/chat-alice']);
});
