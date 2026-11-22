// Settings from environment variables. See .env.example.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export interface Config {
  port: number;
  /** The OpenWebUI instance, without a trailing slash */
  openwebuiUrl: string;
  /** Encrypts the session cookie (the person's OpenWebUI token is inside it) */
  sessionSecret: string;
  sessionHours: number;
  secureCookies: boolean;
  dataDir: string;
  webDist: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.SESSION_SECRET) console.warn('SESSION_SECRET is not set: everyone is signed out on every restart');
  return {
    port: Number(env.PORT) || 3800,
    openwebuiUrl: (env.OPENWEBUI_URL || 'http://217.149.113.34:3000').trim().replace(/\/+$/, ''),
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    sessionHours: Number(env.SESSION_HOURS) || 12,
    secureCookies: env.COOKIE_SECURE === '1' || (env.APP_URL ?? '').startsWith('https://'),
    dataDir: resolve(env.DATA_DIR || new URL('../../../data', import.meta.url).pathname),
    webDist: env.WEB_DIST === '' ? null : resolve(env.WEB_DIST || new URL('../../../web/dist', import.meta.url).pathname),
  };
}
