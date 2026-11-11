import { buildPushPayload, type PushSubscription } from '@block65/webcrypto-web-push';
import type { HubNotification, Message, ProactiveContext, Touchpoint } from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';

export interface Webhook {
  url: string;
  preset: 'bark' | 'ntfy' | 'custom';
  headers?: Record<string, string>;
  body?: unknown;
}
export interface Channel {
  id: string;
  kind: 'webpush' | 'webhook';
  ciphertext: string;
  iv: string;
}

export class PushDeliveryError extends Error {
  override name = 'PushDeliveryError';
}

function safePushDetail(value: string): string {
  return value.replace(/https?:\/\/\S+/g, '[推送地址]').replace(/[A-Za-z0-9_+\/-]{40,}={0,2}/g, '[已隐藏]').slice(0, 300);
}

export function notificationFor(context: ProactiveContext, t: Touchpoint, message: Message): HubNotification {
  return {
    title: context.preview === 'hidden' ? 'AI 陪伴' : context.character.name,
    body: context.preview === 'full' ? message.text.slice(0, 500) : context.preview === 'name-only' ? '给你发来一条消息' : '你有一条新消息',
    tag: message.id,
    route: t.action === 'call' ? `/call/${encodeURIComponent(context.character.id)}?incoming=1` : `/chat/${encodeURIComponent(message.chatId)}`,
  };
}

function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') return value.replace(/\{\{(title|body|url|id)\}\}/g, (_, k: string) => vars[k] ?? '');
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

export async function sendChannel(env: Env, ch: Channel, notification: HubNotification): Promise<void> {
  try {
    await deliverChannel(env, ch, notification);
  } catch (error) {
    if (error instanceof PushDeliveryError) throw error;
    throw new PushDeliveryError(`通知发送失败：${safePushDetail(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}`);
  }
}

async function deliverChannel(env: Env, ch: Channel, notification: HubNotification): Promise<void> {
  let response: Response;
  if (ch.kind === 'webpush') {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new Error('Worker 尚未配置 VAPID');
    const subscription = await unseal<PushSubscription>(env.KEK, ch);
    let payload: Awaited<ReturnType<typeof buildPushPayload>>;
    try {
      payload = await buildPushPayload({ data: JSON.stringify(notification), options: { ttl: 10_800 } }, subscription, {
        publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT,
      });
    } catch (error) {
      throw new PushDeliveryError(`Web Push 加密失败：${safePushDetail(error instanceof Error ? error.message : String(error))}`);
    }
    response = await fetch(subscription.endpoint, { ...payload, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.status === 404 || response.status === 410) {
      await env.DB.prepare('DELETE FROM push_channels WHERE id = ?').bind(ch.id).run();
    }
  } else {
    const config = await unseal<Webhook>(env.KEK, ch);
    const url = new URL(env.APP_URL);
    url.hash = notification.route;
    const vars = { ...notification, url: url.href, id: notification.tag };
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': notification.tag, ...config.headers };
    let body: string;
    if (config.preset === 'ntfy') {
      // ntfy's JSON publish endpoint accepts Unicode titles and text.
      const endpoint = new URL(config.url);
      body = JSON.stringify({ topic: endpoint.pathname.slice(1), title: notification.title, message: notification.body, click: url.href });
      endpoint.pathname = '/';
      response = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } else {
      body = JSON.stringify(config.preset === 'bark' ? { title: notification.title, body: notification.body, url: url.href, group: 'ai-mobile' }
        : substitute(config.body ?? { title: '{{title}}', body: '{{body}}', url: '{{url}}', id: '{{id}}' }, vars));
      response = await fetch(config.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    }
  }
  if (!response.ok) {
    const detail = ch.kind === 'webpush' ? safePushDetail(await response.text()) : '';
    throw new PushDeliveryError(`${ch.kind === 'webpush' ? 'Web Push' : 'Webhook'} 推送失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  if (ch.kind === 'webhook') {
    // Several providers return HTTP 200 for an application error.
    const body = await response.json().catch(() => null) as { code?: number; errcode?: number; success?: boolean } | null;
    if (body && (body.success === false || (body.errcode !== undefined && body.errcode !== 0) || (body.code !== undefined && ![0, 200].includes(body.code)))) {
      throw new Error(`webhook 服务拒绝请求（${body.code ?? body.errcode ?? 'success=false'}）`);
    }
  }
  await env.DB.prepare('UPDATE push_channels SET last_ok_at = ? WHERE id = ?').bind(Date.now(), ch.id).run();
}

export async function deliverPending(env: Env, now: number, touchpointId?: string) {
  const [pending, channels] = await Promise.all([
    env.DB.prepare(`SELECT id, touchpoint_id, notification, created_at FROM messages
      WHERE delivered = 0 AND push_until <= ? AND push_retry_at <= ? AND (? IS NULL OR touchpoint_id = ?)`)
      .bind(now, now, touchpointId ?? null, touchpointId ?? null).all<{ id: string; touchpoint_id: string; notification: string; created_at: number }>(),
    env.DB.prepare('SELECT * FROM push_channels').all<Channel>(),
  ]);
  const results = await Promise.allSettled(pending.results.map(async (row) => {
    const lease = crypto.randomUUID();
    const claimed = await env.DB.prepare('UPDATE messages SET push_lease = ?, push_until = ? WHERE id = ? AND delivered = 0 AND push_until <= ? RETURNING id')
      .bind(lease, now + 60_000, row.id, now).first();
    if (!claimed) return;
    const expired = now - row.created_at > 3 * 3_600_000;
    const outcomes = expired ? [] : await Promise.allSettled(channels.results.map((ch) => sendChannel(env, ch, JSON.parse(row.notification) as HubNotification)));
    const delivered = outcomes.some((o) => o.status === 'fulfilled');
    const error = expired ? '通知已过期，消息仍会同步' : !outcomes.length ? '尚未订阅通知通道' : outcomes.filter((o) => o.status === 'rejected').map((o) => String(o.reason)).join('; ');
    await env.DB.batch([
      env.DB.prepare('UPDATE messages SET delivered = ?, push_lease = NULL, push_until = 0, push_retry_at = ? WHERE id = ? AND push_lease = ?')
        .bind(delivered || expired ? 1 : 0, now + 300_000, row.id, lease),
      env.DB.prepare('UPDATE touchpoints SET status = ?, push_error = ? WHERE id = ?').bind(delivered ? 'delivered' : 'fired', delivered ? null : error, row.touchpoint_id),
    ]);
  }));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
