import { readFileSync, writeFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const id = process.env.HUB_D1_ID || config.d1_databases[0].database_id;
if (!/^[0-9a-f-]{36}$/i.test(id) || /^0+-0+-0+-0+-0+$/.test(id)) throw new Error('Set HUB_D1_ID to the D1 database UUID');
config.d1_databases[0].database_id = id;
if (process.env.CLOUDFLARE_ACCOUNT_ID) config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
if (process.env.HUB_APP_URL) {
  const url = new URL(process.env.HUB_APP_URL);
  config.vars.APP_URL = url.href;
  config.vars.APP_ORIGIN = url.origin;
}
writeFileSync(new URL('../wrangler.deploy.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
console.log('Wrote apps/hub/wrangler.deploy.json (no secrets)');
