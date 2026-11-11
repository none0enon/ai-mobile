import { base64Decode, base64Encode, utf8Encode } from '@app/shared';
import { transportOf, trimUrl, vertexBase, type Endpoint } from '../core/endpoint.ts';
import { AiError, errorText, httpError } from '../core/errors.ts';
import { readText, request } from '../core/http.ts';
import { geminiGenerate, openaiCompatible, VERTEX_SAFETY_OFF, type ChatProvider } from './providers.ts';

/**
 * Vertex Agent：Google 的 Gemini Enterprise Agent Platform（原 Vertex AI）。
 *
 * 两种授权：
 * - API Key（同 math-reader 的 Vertex Agent）：express 模式的 Key，或绑定了服务账号的 Google Cloud API Key。
 *   默认地址 https://aiplatform.googleapis.com/v1/publishers/google，Gemini 走原生协议，Key 放在 key 参数；
 *   这种 Key 只能调 Gemini，也拉不到模型列表（要 OAuth）。
 * - 服务账号 JSON（官方文档里的 Google Cloud 授权）：在本机用私钥签 JWT、换访问令牌，
 *   请求发到 …/projects/{项目}/locations/{地区}/…。这样还能调 DeepSeek 等开源模型：
 *   它们走 OpenAI 兼容的 …/endpoints/openapi/chat/completions，模型名带发布方前缀（deepseek-ai/deepseek-v4.1-flash-maas）。
 *
 * 地区默认 global（官方推荐，DeepSeek-V4.1-Flash 只在 global）；连接的 extra.location、extra.projectId 可以覆盖，
 * 也认粘贴进来的 …/projects/p/locations/l/… 地址。
 */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  token_uri?: string;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Key 是服务账号 JSON 时解析出来；是普通 API Key 时返回 null */
export function parseServiceAccount(key: string | null | undefined): ServiceAccount | null {
  const text = key?.trim();
  if (!text?.startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new AiError('no_key', 'Key 看起来是服务账号 JSON，但解析不了：检查有没有复制完整');
  }
  const sa = v as Partial<ServiceAccount>;
  if (typeof sa?.client_email !== 'string' || typeof sa.private_key !== 'string') {
    throw new AiError('no_key', '服务账号 JSON 里缺 client_email 或 private_key');
  }
  return sa as ServiceAccount;
}

function base64url(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM（-----BEGIN PRIVATE KEY-----）→ PKCS#8 字节；容忍被转义成 \n 字面量的换行 */
function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----(?:BEGIN|END)[^-]*-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');
  return new Uint8Array(base64Decode(body));
}

/** 服务账号换令牌用的 JWT（RS256，WebCrypto 签名，浏览器、Worker、Node 都能用） */
export async function signServiceAccountJwt(sa: ServiceAccount, nowSec: number): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) };
  const claims = { iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const input = `${base64url(utf8Encode(JSON.stringify(header)))}.${base64url(utf8Encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new Uint8Array(utf8Encode(input))));
  return `${input}.${base64url(signature)}`;
}

/** 访问令牌按服务账号缓存，过期前一分钟换新的 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function vertexAccessToken(ep: Endpoint, sa: ServiceAccount, signal?: AbortSignal): Promise<string> {
  const cacheKey = `${sa.client_email}|${sa.private_key_id ?? ''}`;
  const now = Date.now();
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt - 60_000 > now) return hit.token;
  let jwt: string;
  try {
    jwt = await signServiceAccountJwt(sa, Math.floor(now / 1000));
  } catch (e) {
    throw new AiError('no_key', `服务账号的私钥用不了：${errorText(e)}`);
  }
  const res = await request(transportOf(ep), ep.name, sa.token_uri || GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
    signal,
  });
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new AiError('bad_response', `${ep.name}：换访问令牌时没有拿到 access_token`);
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

/** 测试用：清掉缓存的访问令牌 */
export function clearVertexTokens(): void {
  tokenCache.clear();
}

/** 用服务账号时请求发到哪个项目、哪个地区：连接的设置 → 粘贴的地址 → 服务账号里的 project_id；地区默认 global */
function projectOf(ep: Endpoint, sa: ServiceAccount): { project: string; location: string } {
  const fromUrl = trimUrl(ep.baseUrl || '').match(/\/projects\/([^/]+)\/locations\/([^/]+)/);
  const project = ep.extra?.projectId?.trim() || fromUrl?.[1] || sa.project_id;
  if (!project) throw new AiError('no_key', `"${ep.name}" 不知道用哪个项目：服务账号 JSON 里没有 project_id，请填项目 ID`);
  const location = ep.extra?.location?.trim() || fromUrl?.[2] || 'global';
  return { project, location };
}

function vertexOrigin(location: string): string {
  return location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`;
}

/** 去掉模型名前面多余的路径：publishers/google/models/gemini-x、models/gemini-x、google/gemini-x */
export function vertexModelName(model: string): string {
  return model.trim().replace(/^(?:publishers\/google\/models\/|models\/|google\/(?=gemini))/, '');
}

/** 开源模型（MaaS）：带发布方前缀的 id（deepseek-ai/deepseek-v4.1-flash-maas），或以 -maas 结尾的名字 */
export function isVertexOpenModel(model: string): boolean {
  const m = vertexModelName(model);
  if (/^gemini-/i.test(m)) return false;
  return m.includes('/') || /-maas$/i.test(m);
}

/** OpenAI 兼容接口要带发布方前缀；DeepSeek 的模型页只写了 deepseek-v4.1-flash-maas，补上 deepseek-ai/ */
export function vertexOpenModelId(model: string): string {
  const m = vertexModelName(model);
  if (m.includes('/')) return m;
  return /^deepseek-/i.test(m) ? `deepseek-ai/${m}` : m;
}

export const vertexChat: ChatProvider = async (ep, req, call) => {
  const model = vertexModelName(ep.model);
  const sa = parseServiceAccount(ep.key);

  if (isVertexOpenModel(model)) {
    // 官方：开源模型的 OpenAI 兼容接口只认 Google Cloud 授权（访问令牌），API Key 不行
    if (!sa) {
      throw new AiError('no_key', `"${ep.name}"：DeepSeek 等开源模型要用服务账号 JSON 授权（官方的 OpenAI 兼容接口只认 Google Cloud 授权），API Key 只能调 Gemini`);
    }
    const token = await vertexAccessToken(ep, sa, call.signal);
    const { project, location } = projectOf(ep, sa);
    return openaiCompatible(ep, req, call, {
      url: `${vertexOrigin(location)}/v1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(ep.headers ?? {}) },
      model: vertexOpenModelId(model),
      // 官方：第一条必须是 user，user 和 assistant 轮流；最后一条是 assistant 时从它接着写
      processing: 'strict',
    });
  }

  if (sa) {
    const { project, location } = projectOf(ep, sa);
    const base = `${vertexOrigin(location)}/v1/projects/${project}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}`;
    return geminiGenerate(ep, req, call, model, {
      target: async (stream) => ({
        url: `${base}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
        headers: { Authorization: `Bearer ${await vertexAccessToken(ep, sa, call.signal)}` },
      }),
      safety: VERTEX_SAFETY_OFF,
      upperLevel: true,
      cacheKey: `${base}|vertex`,
    });
  }

  // API Key（同 math-reader）：{base}/models/{model}:streamGenerateContent?alt=sse&key=…
  const base = vertexBase(ep.baseUrl);
  const key = encodeURIComponent(ep.key ?? '');
  return geminiGenerate(ep, req, call, model, {
    target: async (stream) => ({
      url: `${base}/models/${encodeURIComponent(model)}${stream ? `:streamGenerateContent?alt=sse&key=${key}` : `:generateContent?key=${key}`}`,
      headers: {},
    }),
    safety: VERTEX_SAFETY_OFF,
    upperLevel: true,
    cacheKey: `${base}|${model}`,
  });
};
