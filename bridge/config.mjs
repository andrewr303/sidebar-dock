import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./.local/config.json', import.meta.url));
export async function loadConfig(path = process.env.STILL_BRIDGE_CONFIG || DEFAULT_CONFIG_PATH, { create = false } = {}) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw new Error(error.code === 'ENOENT' ? 'Start bridge/server.mjs first to create its local configuration.' : 'The bridge configuration is unreadable.');
    await mkdir(dirname(resolve(path)), { recursive: true });
    value = { url: 'http://127.0.0.1:43123', token: randomBytes(32).toString('base64url') };
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Bridge configuration must use http://127.0.0.1 with an optional port.');
  if (typeof value.token !== 'string' || value.token.length < 24 || /[\r\n]/.test(value.token)) throw new Error('Bridge configuration needs a valid random token.');
  return { url: url.origin, token: value.token, path: resolve(path) };
}
