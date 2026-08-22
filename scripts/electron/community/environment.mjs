import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

export const COMMUNITY_ENV_DEFAULTS = Object.freeze({
  TABTIN_LOCAL_DEV_MODE: 'native',
  TABTIN_API_BASE_URL: 'http://127.0.0.1:6060/api',
  VITE_API_BASE_URL: 'http://127.0.0.1:6060/api',
  VITE_COLLAB_WS_BASE: 'ws://127.0.0.1:4100',
  VITE_CENTRIFUGO_WS_URL: 'ws://127.0.0.1:8100/connection/websocket',
  VITE_PUBLIC_WEB_BASE_URL: 'http://127.0.0.1:5176',
  VITE_DEV_SERVER_PORT: '5175',
  VITE_DISTRIBUTION_KIND: 'community',
});

const URL_ENV_KEYS = new Set([
  'TABTIN_API_BASE_URL',
  'VITE_API_BASE_URL',
  'VITE_COLLAB_WS_BASE',
  'VITE_CENTRIFUGO_WS_URL',
  'VITE_PUBLIC_WEB_BASE_URL',
]);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function mergeCommunityEnv(existing) {
  return Object.fromEntries(
    Object.entries(COMMUNITY_ENV_DEFAULTS).map(([key, defaultValue]) => [
      key,
      existing[key] ?? defaultValue,
    ]),
  );
}

export function parseEnvText(text) {
  const values = {};

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!match) continue;

    const [, key, rawValue] = match;
    values[key] = unquoteEnvValue(rawValue);
  }

  return values;
}

export function validateCommunityEnv(values) {
  const issues = [];
  const requiresLocalHosts = values.TABTIN_LOCAL_DEV_MODE === 'native';
  const placeholderKeys = new Set();

  for (const key of Object.keys(COMMUNITY_ENV_DEFAULTS)) {
    if (/\$\{[^}]+\}/.test(values[key])) {
      issues.push({ key, reason: 'contains an unresolved placeholder' });
      placeholderKeys.add(key);
    }
  }

  for (const key of URL_ENV_KEYS) {
    const value = values[key];
    if (placeholderKeys.has(key)) continue;

    let url;
    try {
      url = new URL(value);
    } catch {
      issues.push({ key, reason: 'is not a valid URL' });
      continue;
    }

    if (url.username || url.password) {
      issues.push({ key, reason: 'must not include credentials' });
      continue;
    }

    if (requiresLocalHosts && !LOCAL_HOSTS.has(url.hostname)) {
      issues.push({ key, reason: 'uses an unknown remote host in local mode' });
    }
  }

  return issues;
}

export async function ensureCommunityEnvFile(filePath) {
  const existingText = await readEnvironmentFile(filePath);
  const values = mergeCommunityEnv(parseEnvText(existingText));
  const issues = validateCommunityEnv(values);
  if (issues.length > 0) {
    throw new Error(formatValidationIssues(issues));
  }

  const nextText = serializeCommunityEnv(values);
  if (existingText === nextText) {
    return { values, changed: false };
  }

  const temporaryFile = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryFile, nextText, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryFile, filePath);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }

  return { values, changed: true };
}

async function readEnvironmentFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function serializeCommunityEnv(values) {
  return `${Object.keys(COMMUNITY_ENV_DEFAULTS)
    .map((key) => `${key}=${values[key]}`)
    .join('\n')}\n`;
}

function formatValidationIssues(issues) {
  return `Invalid community environment: ${issues
    .map(({ key, reason }) => `${key} ${reason}`)
    .join('; ')}`;
}

function unquoteEnvValue(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value.replace(/\s+#.*$/, '').trimEnd();
}
