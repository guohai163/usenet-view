import { isIP } from 'node:net';

export const groupNamePattern = /^[A-Za-z0-9+_-]+(?:\.[A-Za-z0-9+_-]+)*$/;
export const maxDatabaseNumber = 9223372036854775807n;

function integerSetting(name, fallback, min, max) {
  const input = process.env[name] ?? String(fallback);
  const value = Number(input);
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
}

export function baseConfig() {
  const input = (process.env.NNTP_HOST ?? '').trim().toLowerCase().replace(/\.$/, '');
  const ipVersion = input.includes('%') ? 0 : isIP(input);
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!ipVersion && (input.length > 253 || !input.split('.').every(label => dnsLabel.test(label)))) {
    throw new Error('请在 .env 中将 NNTP_HOST 设置为 NNTP 服务器的域名、IPv4 或 IPv6 地址。');
  }
  const host = ipVersion === 6 ? new URL(`http://[${input}]`).hostname.slice(1, -1) : input;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error('请在 .env 中填写 PostgreSQL 的 DATABASE_URL。');
  }
  return { host, databaseUrl };
}

export function webConfig() {
  return {
    ...baseConfig(),
    webHost: process.env.WEB_HOST || '127.0.0.1',
    webPort: integerSetting('WEB_PORT', 3000, 1, 65535),
  };
}

export function syncConfig() {
  return {
    ...baseConfig(),
    groups: [...new Set((process.env.NNTP_GROUPS ?? '').split(',').map(group => group.trim()).filter(Boolean))],
    initialLimit: BigInt(integerSetting('NNTP_INITIAL_LIMIT', 0, 0, Number.MAX_SAFE_INTEGER)),
    intervalSeconds: integerSetting('NNTP_SYNC_INTERVAL_SEC', 300, 1, 86400),
    timeoutMs: integerSetting('NNTP_TIMEOUT_MS', 30000, 1000, 300000),
    maxArticleBytes: integerSetting('NNTP_MAX_ARTICLE_BYTES', 67108864, 1024, 268435456),
  };
}

export function articleNumber(value) {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) return null;
  const number = BigInt(value);
  return number <= maxDatabaseNumber ? number : null;
}
