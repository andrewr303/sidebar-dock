const MAX_BYTES = 32 * 1024 * 1024;
export function validateProviderUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter an absolute AI provider base URL.'); }
  if (url.username || url.password || url.hash || url.search || !['http:', 'https:'].includes(url.protocol)) throw new Error('AI provider URLs cannot contain credentials, query strings or fragments.');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Remote AI providers require HTTPS. HTTP is allowed only for loopback servers.');
  return url.href.replace(/\/$/, '');
}
export function requestSignal(signal, timeoutMs = 120000) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
export async function* bodyChunks(response, { signal, maximum = MAX_BYTES } = {}) {
  if (!response.body) throw new Error('The AI provider returned no response body.');
  const reader = response.body.getReader();
  let count = 0;
  const cancel = () => { reader.cancel(signal.reason).catch(() => {}); };
  try {
    signal?.throwIfAborted(); signal?.addEventListener('abort', cancel, { once: true });
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      count += value.length;
      if (count > maximum) throw new Error('The AI response exceeded the local safety limit.');
      yield value;
    }
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function readJson(response, options = {}) {
  const decoder = new TextDecoder(); let source = '';
  for await (const chunk of bodyChunks(response, { ...options, maximum: options.maximum || 8 * 1024 * 1024 })) source += decoder.decode(chunk, { stream: true });
  source += decoder.decode();
  try { return JSON.parse(source); } catch { throw new Error('The AI provider returned invalid JSON.'); }
}
export async function checkedFetch(fetcher, url, options) {
  const response = await fetcher(url, { ...options, redirect: 'error', cache: 'no-store' });
  if (!response.ok) {
    let message = `AI provider returned HTTP ${response.status}.`;
    try { const data = await readJson(response, { signal: options.signal, maximum: 65536 }); message = data.error?.message || data.message || (typeof data.error === 'string' ? data.error : message); } catch (error) { if (options.signal?.aborted) throw error; }
    throw new Error(String(message).slice(0, 2000));
  }
  return response;
}
export async function readSSE(response, onEvent, options = {}) {
  const decoder = new TextDecoder(); let buffer = '', data = [], event = '';
  const line = async value => {
    if (!value) { if (data.length) await onEvent({ event, data: data.join('\n') }); data = []; event = ''; return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'); const name = colon < 0 ? value : value.slice(0, colon); let content = colon < 0 ? '' : value.slice(colon + 1); if (content.startsWith(' ')) content = content.slice(1);
    if (name === 'data') data.push(content); else if (name === 'event') event = content;
    if (data.reduce((sum, value) => sum + value.length, 0) > 2 * 1024 * 1024) throw new Error('The AI stream event exceeded the local safety limit.');
  };
  for await (const chunk of bodyChunks(response, options)) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 2 * 1024 * 1024) throw new Error('The AI stream line exceeded the local safety limit.');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) { const value = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1); await line(value); }
  }
  buffer += decoder.decode();
  if (buffer) await line(buffer.replace(/\r$/, ''));
  if (data.length) await line('');
}
export async function readNDJSON(response, onEvent, options = {}) {
  const decoder = new TextDecoder(); let buffer = '';
  const parse = async value => { if (!value.trim()) return; let event; try { event = JSON.parse(value); } catch { throw new Error('The AI provider returned an invalid NDJSON event.'); } await onEvent(event); };
  for await (const chunk of bodyChunks(response, options)) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 2 * 1024 * 1024) throw new Error('The AI stream event exceeded the local safety limit.');
    let index; while ((index = buffer.indexOf('\n')) !== -1) { const value = buffer.slice(0, index); buffer = buffer.slice(index + 1); await parse(value); }
  }
  buffer += decoder.decode(); if (buffer.trim()) await parse(buffer);
}
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
function eventHeaders(bytes) {
  const headers = {}; let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset++]; const name = bytes.subarray(offset, offset + length).toString('utf8'); offset += length;
    const type = bytes[offset++];
    if ([6, 7].includes(type)) { const size = bytes.readUInt16BE(offset); offset += 2; if (offset + size > bytes.length) throw new Error('Truncated AWS event headers.'); if (type === 7) headers[name] = bytes.subarray(offset, offset + size).toString('utf8'); offset += size; }
    else if ([0, 1].includes(type)) headers[name] = type === 0;
    else { const size = { 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 }[type]; if (!size || offset + size > bytes.length) throw new Error('Invalid AWS event header.'); offset += size; }
  }
  return headers;
}
export async function readBedrockEvents(response, onEvent, options = {}) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of bodyChunks(response, options)) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 12) {
      const total = buffer.readUInt32BE(0), headerLength = buffer.readUInt32BE(4);
      if (total < 16 || total > 8 * 1024 * 1024 || headerLength > total - 16 || crc32(buffer.subarray(0, 8)) !== buffer.readUInt32BE(8)) throw new Error('Invalid AWS event-stream prelude.');
      if (buffer.length < total) break;
      const frame = buffer.subarray(0, total); buffer = buffer.subarray(total);
      if (crc32(frame.subarray(0, total - 4)) !== frame.readUInt32BE(total - 4)) throw new Error('AWS event-stream checksum mismatch.');
      const headers = eventHeaders(frame.subarray(12, 12 + headerLength));
      let event; try { event = JSON.parse(frame.subarray(12 + headerLength, total - 4).toString('utf8')); } catch { throw new Error('Invalid AWS event-stream JSON.'); }
      if (headers[':message-type'] === 'exception' || headers[':message-type'] === 'error') throw new Error(event.message || headers[':exception-type'] || 'AWS streaming inference failed.');
      await onEvent({ type: headers[':event-type'], ...event });
    }
  }
  if (buffer.length) throw new Error('AWS event stream ended in the middle of a frame.');
}
