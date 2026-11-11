import { writeFileSync } from 'node:fs';
import { randomBytes, webcrypto } from 'node:crypto';
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/create-secrets.mjs /path/to/hub.secrets.json [mailto:contact@example.com]');
const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const privateKey = (await webcrypto.subtle.exportKey('jwk', pair.privateKey)).d;
writeFileSync(file, JSON.stringify({
  HUB_PASSWORD: randomBytes(24).toString('base64url'),
  KEK: randomBytes(32).toString('base64'),
  VAPID_PUBLIC_KEY: publicKey,
  VAPID_PRIVATE_KEY: privateKey,
  VAPID_SUBJECT: process.argv[3] || 'https://github.com/none0enon/ai-mobile',
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Created ${file}; retain it for recovery. Secret values are not printed.`);
