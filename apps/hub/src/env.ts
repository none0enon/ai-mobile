export interface Env {
  DB: D1Database;
  HUB_PASSWORD: string;
  /** Base64-encoded 32-byte AES key. */
  KEK: string;
  APP_ORIGIN: string;
  APP_URL: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}
