const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function digest(value: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function key(kek: string) {
  const bytes = decode(kek);
  if (bytes.length !== 32) throw new Error('KEK 必须是 32 字节的 base64 密钥');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(kek: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(kek), new TextEncoder().encode(JSON.stringify(value)));
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function unseal<T>(kek: string, value: { iv: string; ciphertext: string }): Promise<T> {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv) }, await key(kek), decode(value.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
