// Streaming readers shared by every transport: Server-Sent Events and newline-delimited JSON.
// Both stop promptly on abort: the reader is cancelled, which settles any pending read, and an AbortError is thrown.

const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_CHARS = 8 * 1024 * 1024;

export function abortError(signal) {
  const reason = signal?.reason;
  const timeout = reason?.name === 'TimeoutError';
  const error = new Error(timeout ? 'The request timed out.' : 'Stopped.');
  error.name = timeout ? 'TimeoutError' : 'AbortError';
  error.code = timeout ? 'timeout' : 'aborted';
  error.aborted = !timeout;
  if (reason !== undefined) error.cause = reason;
  return error;
}

async function* readChunks(response, { signal, maxBytes = MAX_STREAM_BYTES } = {}) {
  if (signal?.aborted) throw abortError(signal);
  if (!response?.body?.getReader) throw new Error('The provider returned no response stream.');
  const reader = response.body.getReader();
  const cancel = () => { reader.cancel(signal.reason).catch(() => {}); };
  let total = 0;
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      let step;
      try { step = await reader.read(); }
      catch (error) { if (signal?.aborted) throw abortError(signal); throw error; }
      if (signal?.aborted) throw abortError(signal);
      if (step.done) return;
      total += step.value.byteLength;
      if (total > maxBytes) throw new Error('The response exceeded the local size limit.');
      yield step.value;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}

// Yields { event, data } per dispatched SSE event. Handles LF, CRLF and lone CR line endings split across chunks,
// multi-line data fields, comments and a trailing event without its final blank line.
async function* readSse(response, { signal, maxBytes } = {}) {
  const decoder = new TextDecoder();
  let buffer = '', data = [], event = '', size = 0, first = true;
  const take = line => {
    if (line === '') {
      if (!data.length) { event = ''; return null; }
      const dispatched = { event: event || 'message', data: data.join('\n') };
      data = []; event = ''; size = 0;
      return dispatched;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      size += value.length;
      if (size > MAX_EVENT_CHARS) throw new Error('A streamed event exceeded the local size limit.');
      data.push(value);
    } else if (field === 'event') event = value;
    return null;
  };
  const lines = function* (final) {
    for (;;) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0) break;
      // A CR at the end of the buffer may be the first half of CRLF; wait for the next chunk.
      if (buffer[index] === '\r' && index === buffer.length - 1 && !final) break;
      const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + width);
      yield line;
    }
    if (buffer.length > MAX_EVENT_CHARS) throw new Error('A streamed line exceeded the local size limit.');
  };
  for await (const chunk of readChunks(response, { signal, maxBytes })) {
    buffer += decoder.decode(chunk, { stream: true });
    if (first && buffer) { if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1); first = false; }
    // One chunk can hold many events; stop handing them out as soon as the caller aborts.
    for (const line of lines(false)) { const dispatched = take(line); if (dispatched) { if (signal?.aborted) throw abortError(signal); yield dispatched; } }
  }
  buffer += decoder.decode();
  for (const line of lines(true)) { const dispatched = take(line); if (dispatched) yield dispatched; }
  if (buffer) { const dispatched = take(buffer); buffer = ''; if (dispatched) yield dispatched; }
  const tail = take('');
  if (tail) yield tail;
}

async function* readNdjson(response, { signal, maxBytes } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = line => {
    const value = line.replace(/\r$/, '');
    if (!value.trim()) return undefined;
    try { return JSON.parse(value); } catch { throw new Error('The provider sent an unreadable stream event.'); }
  };
  for await (const chunk of readChunks(response, { signal, maxBytes })) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const value = parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (value !== undefined) { if (signal?.aborted) throw abortError(signal); yield value; }
    }
    if (buffer.length > MAX_EVENT_CHARS) throw new Error('A streamed event exceeded the local size limit.');
  }
  buffer += decoder.decode();
  const value = parse(buffer);
  if (value !== undefined) yield value;
}

// Exported through a list: scripts/check.mjs does not recognise generator declarations as exports.
export { readChunks, readSse, readNdjson };

export function parseEventData(data) {
  try { return JSON.parse(data); } catch { throw new Error('The provider sent an unreadable stream event.'); }
}
