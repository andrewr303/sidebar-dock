import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

const AAD = Buffer.from('still-ai-provider-store-v1');
async function rejectSymlink(path) {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('AI credential files cannot be symbolic links.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function createEncryptedStore({ configPath, keyPath = `${configPath}.key` }) {
  if (!configPath) throw new Error('An AI provider configuration path is required.');
  let queue = Promise.resolve();
  async function key(create) {
    await rejectSymlink(keyPath);
    try { const bytes = await readFile(keyPath); if (bytes.length !== 32) throw new Error('The AI encryption key has an invalid length.'); return bytes; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) throw new Error('The local AI encryption key is missing. Restore the matching key file before continuing.');
      await mkdir(dirname(keyPath), { recursive: true });
      const bytes = randomBytes(32);
      try { await writeFile(keyPath, bytes, { flag: 'wx', mode: 0o600 }); return bytes; }
      catch (writeError) { if (writeError.code === 'EEXIST') return key(false); throw writeError; }
    }
  }
  async function read() {
    await rejectSymlink(configPath);
    let raw;
    try { raw = await readFile(configPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, providers: [] }; throw error; }
    let record;
    try {
      record = JSON.parse(raw);
      if (record.version !== 1 || typeof record.data !== 'string' || typeof record.iv !== 'string' || typeof record.tag !== 'string') throw new Error();
      const iv = Buffer.from(record.iv, 'base64'); const tag = Buffer.from(record.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', await key(false), iv);
      decipher.setAAD(AAD); decipher.setAuthTag(tag);
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8'));
      if (value.version !== 1 || !Array.isArray(value.providers)) throw new Error();
      return value;
    } catch (error) {
      if (error.message.includes('key is missing')) throw error;
      throw new Error('The local AI credential store cannot be decrypted. Restore its matching key and ciphertext; it has not been overwritten.');
    }
  }
  async function write(value) {
    await rejectSymlink(configPath);
    await mkdir(dirname(configPath), { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await key(true), iv); cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const record = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
    const temporary = `${configPath}.${randomBytes(8).toString('hex')}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, configPath); }
    catch (error) { try { await unlink(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], 'AI credential write and cleanup failed.'); } throw error; }
  }
  function update(mutator) {
    const task = queue.then(async () => { const value = await read(); const result = await mutator(value); await write(value); return result; });
    queue = task.catch(() => {});
    return task;
  }
  return { read, update };
}
