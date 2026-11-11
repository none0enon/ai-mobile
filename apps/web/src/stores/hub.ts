import { apiKeyId, DEFAULT_PROACTIVE_RULES, type HubInbox, type HubStatus, type HubTouchpoint,
  type Message, type NotificationPreview, type ProactiveContext, type ProactiveCredentials } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';
import { getOne, write } from '@/db/idb';
import { memories } from '@/mock/memories';
import { personaOf } from '@/services/prompt';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useChatStore } from './chat';
import { useEnvironmentStore } from './environment';
import { useLibraryStore } from './library';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
interface SavedHub {
  url: string; cursor: number; deviceId: string; active: boolean; preview: NotificationPreview;
  revisions: Record<string, number>; hashes: Record<string, string>; apiHash: string;
}
export const useHubStore = defineStore('hub', () => {
  const config = reactive<SavedHub>({ url: '', cursor: 0, deviceId: '', active: false, preview: 'name-only', revisions: {}, hashes: {}, apiHash: '' });
  const token = ref('');
  const savedPassword = ref('');
  const connected = computed(() => !!config.url && !!token.value);
  const status = ref<HubStatus | null>(null);
  const points = ref<HubTouchpoint[]>([]);
  const lastSyncAt = ref<number | null>(null);
  const error = ref('');
  const syncing = ref(false);
  let started = false;
  let connectionVersion = 0;
  const uploading = new Set<string>();
  const save = () => write('settings', [{ key: 'hub', value: clone(config) }]);

  async function request<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const version = connectionVersion;
    const response = await fetch(`${config.url}${path}`, {
      method, headers: { Authorization: `Bearer ${token.value}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30_000), cache: 'no-store',
    });
    const result = await response.json() as T & { error?: string };
    if (version !== connectionVersion) throw new Error('连接已切换');
    if (!response.ok) throw new Error(result.error || `Worker HTTP ${response.status}`);
    return result;
  }

  async function hydrate() {
    const [saved, secret, password] = await Promise.all([getOne<SavedHub>('settings', 'hub'), getOne<string>('secrets', 'hub:token'), getOne<string>('secrets', 'hub:password')]);
    if (saved) Object.assign(config, saved);
    token.value = secret ?? '';
    savedPassword.value = password ?? '';
  }

  async function connect(url: string, password: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Worker 地址必须是 HTTPS');
    const base = parsed.origin;
    const response = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as { token: string; deviceId: string; error?: string };
    if (!response.ok) throw new Error(result.error || `登录失败 HTTP ${response.status}`);
    connectionVersion++;
    if (config.url !== base) Object.assign(config, { cursor: 0, active: false, revisions: {}, hashes: {}, apiHash: '' });
    config.url = base;
    config.deviceId = result.deviceId;
    token.value = result.token;
    if (!await write('secrets', [{ key: 'hub:token', value: result.token }, { key: 'hub:password', value: password }])) throw new Error('无法保存登录信息，请允许浏览器存储');
    savedPassword.value = password;
    const remote = await request<{ contexts: { id: string; revision: number }[] }>('/v1/proactive/contexts');
    // Reconnect is an explicit choice of this device as the source of context updates.
    config.revisions = Object.fromEntries(remote.contexts.map((c) => [c.id, c.revision]));
    config.hashes = {};
    await refreshStatus();
    if (!await save()) throw new Error('无法保存连接地址，请允许浏览器存储');
    await pull();
  }

  async function disconnect() {
    // Disconnect this device; the separate cloud switch controls scheduled generation.
    try { await request('/v1/auth/session', 'DELETE'); } catch { /* Local disconnect also works offline. */ }
    connectionVersion++;
    token.value = ''; status.value = null; points.value = []; lastSyncAt.value = null;
    config.active = false; config.deviceId = ''; error.value = ''; syncing.value = false;
    const [saved, removed] = await Promise.all([save(), write('secrets', [], ['hub:token'])]);
    if (!saved || !removed) throw new Error('已断开，但本机未能保存状态，请允许浏览器存储');
  }

  async function refreshStatus() {
    status.value = await request<HubStatus>('/v1/status');
    config.active = status.value.enabled;
  }

  async function hash(value: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function contexts(): ProactiveContext[] {
    const chars = useCharacterStore();
    const chats = useChatStore();
    const lib = useLibraryStore();
    return chars.list.flatMap((character) => {
      const chat = chats.chatOfCharacter(character.id);
      if (!chat || chats.streams[chat.id]) return [];
      // Local blob URLs / media are not useful to the server. Text, preset and lorebook stay intact.
      return [{ character: { ...character, avatar: null }, chat, persona: { ...personaOf(chat), avatar: null },
        preset: lib.presetForUse('proactive', character) ?? null,
        lorebooks: character.lorebookIds.map((id) => lib.lorebookById(id)).filter((b) => !!b),
        history: chats.list(chat.id).filter((m) => !m.meta.error && !m.meta.interrupted).slice(-200),
        memories: memories.filter((m) => m.characterId === character.id && m.status === 'active').map(({ id, content, dueAt, type }) => ({ id, content, ...(dueAt ? { dueAt } : {}), type })),
        environment: useEnvironmentStore().settings, rules: DEFAULT_PROACTIVE_RULES,
        busyUntil: ['study', 'sleep'].includes(chat.currentScene ?? '') ? chat.lastMessageAt + 4 * 3_600_000 : 0,
        preview: config.preview }];
    });
  }

  async function uploadContexts() {
    const snapshots = clone(contexts());
    const present = new Set(useCharacterStore().list.map((c) => c.id));
    // Independent characters upload concurrently. A change during its own upload is picked up next tick.
    const outcomes = await Promise.allSettled(snapshots.map(async (context) => {
      const id = context.character.id;
      if (uploading.has(id)) return;
      uploading.add(id);
      try {
        const fingerprint = await hash(context);
        if (config.hashes[id] === fingerprint) return;
        const result = await request<{ revision: number }>(`/v1/proactive/contexts/${encodeURIComponent(id)}`, 'PUT', { context, revision: config.revisions[id] ?? 0 });
        config.revisions[id] = result.revision;
        config.hashes[id] = fingerprint;
      } finally { uploading.delete(id); }
    }).concat(Object.keys(config.hashes).filter((id) => !present.has(id)).map(async (id) => {
      await request(`/v1/proactive/contexts/${encodeURIComponent(id)}`, 'DELETE');
      delete config.hashes[id]; delete config.revisions[id];
    })));
    await save();
    const failed = outcomes.find((o) => o.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  async function uploadApi() {
    const ai = useAiStore();
    if (!ai.isLive('proactive')) throw new Error('请先在 API 设置中接通主动消息');
    const source = ai.system.router.source('proactive');
    const credentials: ProactiveCredentials = clone({
      routes: ai.routes.filter((r) => r.role === 'proactive' || r.role === source),
      keys: Object.fromEntries([apiKeyId(source), apiKeyId(source, true)].map((id) => [id, ai.keyOf(id) ?? ''])),
      outputFilters: ai.outputFilters,
    });
    const fingerprint = await hash(credentials);
    if (config.apiHash === fingerprint && status.value?.configured) return;
    await request('/v1/secrets/proactive', 'PUT', credentials);
    config.apiHash = fingerprint;
    await save();
  }

  async function ingest(rows: HubInbox['messages']) {
    const chats = useChatStore();
    const app = useAppStore();
    const changed = new Set<string>();
    for (const row of rows) {
      const chat = chats.chatOfCharacter(row.characterId);
      if (!chat) throw new Error('云端消息对应的角色尚未导入这台设备，请导入后再次同步');
      if (chats.streams[chat.id]) throw new Error('角色正在回复，生成结束后会补齐云端消息');
      changed.add(chat.id);
      if (chats.list(chat.id).some((m) => m.id === row.message.id)) continue;
      const message: Message = { ...row.message, chatId: chat.id, read: app.viewingChatId === chat.id };
      chats.messages[chat.id] ??= [];
      chats.messages[chat.id]!.push(message);
      chats.messages[chat.id]!.sort((a, b) => a.createdAt - b.createdAt);
      chat.lastMessageAt = Math.max(chat.lastMessageAt, message.createdAt);
      changed.add(chat.id);
      if (!message.read) app.showBanner({ characterId: row.characterId, title: useCharacterStore().byId(row.characterId)?.name ?? '新消息', text: message.text,
        to: message.parts.some((p) => p.type === 'call-log') ? `/call/${row.characterId}?incoming=1` : `/chat/${chat.id}`, icon: 'i-lucide-bell-ring' });
    }
    // Persist before advancing the server cursor. Repeated pages are safe because message IDs are stable.
    const saved = await Promise.all([
      write('messages', [...changed].map((id) => ({ key: id, value: clone(chats.list(id)) }))),
      write('chats', [...changed].map((id) => ({ key: id, value: clone(chats.chatById(id)) }))),
    ]);
    if (saved.some((ok) => !ok)) throw new Error('消息未能写入本机存储，下次同步会重试');
  }

  async function pull() {
    // Pagination is a data dependency, not a job queue; it does not run or delay generation.
    let more = true;
    while (more) {
      const inbox = await request<HubInbox>(`/v1/inbox?since=${config.cursor}`);
      await ingest(inbox.messages);
      if (!await write('settings', [{ key: 'hub', value: { ...clone(config), cursor: inbox.next } }])) throw new Error('无法保存同步进度');
      config.cursor = inbox.next;
      points.value = inbox.touchpoints;
      more = inbox.more;
    }
  }

  async function syncNow() {
    if (!connected.value || syncing.value) return;
    const version = connectionVersion;
    syncing.value = true;
    try {
      await refreshStatus();
      // Context updates and inbox reads are independent. Neither starts cloud generation.
      const jobs = await Promise.allSettled([pull(), ...(config.active ? [uploadContexts(), uploadApi()] : [])]);
      const failure = jobs.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      lastSyncAt.value = Date.now(); error.value = '';
    } catch (e) { if (version === connectionVersion) error.value = e instanceof Error ? e.message : String(e); }
    finally { if (version === connectionVersion) syncing.value = false; }
  }

  async function enable() {
    await Promise.all([uploadContexts(), uploadApi()]);
    await request('/v1/proactive/enabled', 'PUT', { enabled: true });
    await refreshStatus(); await save(); error.value = '';
  }
  async function disable() {
    await request('/v1/proactive/enabled', 'PUT', { enabled: false });
    config.active = false; await save(); await refreshStatus();
  }
  async function subscribe() {
    // Called directly from a click: iOS requires a user gesture for this permission.
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('此浏览器不支持 Web Push；iPhone 请先添加到主屏幕再打开');
    if (await Notification.requestPermission() !== 'granted') throw new Error('未允许通知，请在系统设置中开启');
    const key = status.value?.vapidPublicKey;
    if (!key) throw new Error('Worker 尚未设置 VAPID 密钥');
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active) throw new Error('请先安装或打开正式版 App，等待 Service Worker 就绪');
    const subscription = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) });
    await request('/v1/push/subscribe', 'POST', { kind: 'webpush', label: '这台设备', config: subscription.toJSON() });
    await refreshStatus();
  }
  async function addWebhook(data: { url: string; preset: string; headers?: Record<string, string>; body?: unknown }) {
    await request('/v1/push/subscribe', 'POST', { kind: 'webhook', label: data.preset === 'custom' ? '自定义 webhook' : data.preset, config: data });
    await refreshStatus();
  }
  async function removeChannel(id: string) { await request(`/v1/push/channels/${encodeURIComponent(id)}`, 'DELETE'); await refreshStatus(); }
  async function testChannel(id: string) { await request(`/v1/push/channels/${encodeURIComponent(id)}`, 'POST'); await refreshStatus(); }

  function start() {
    if (started) return;
    started = true;
    void syncNow();
    setInterval(() => void syncNow(), 60_000);
    const refresh = () => { if (document.visibilityState === 'visible') void syncNow(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', () => void syncNow());
    navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'hub-inbox') void syncNow(); });
    watch(() => config.preview, () => { void save(); });
    let debounce: ReturnType<typeof setTimeout>;
    watch(() => [contexts(), useAiStore().routes, useAiStore().outputFilters,
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('proactive'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('proactive'), true)), useChatStore().streams], () => {
      clearTimeout(debounce); debounce = setTimeout(() => void syncNow(), 500);
    }, { deep: true });
  }
  return { config, savedPassword, connected, status, points, error, syncing, lastSyncAt, hydrate, connect, disconnect, syncNow, enable, disable, subscribe, addWebhook, removeChannel, testChannel, start };
});
