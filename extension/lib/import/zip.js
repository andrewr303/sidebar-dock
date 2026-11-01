// Minimal ZIP reader for document imports (DOCX, ODT, PPTX, XLSX, EPUB). Reads the central directory, then stored or
// deflated entries through the platform DecompressionStream. No encryption, no ZIP64, no multi-disk archives.
// Node-importable (Node 22 has DecompressionStream); the extension runs it in its pages.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const utf8 = new TextDecoder('utf-8');

export const MAX_ENTRY_BYTES = 96 * 1024 * 1024;
const MAX_ENTRIES = 20000;

export class ImportError extends Error {
  constructor(message, code = 'import_failed') { super(message); this.name = 'ImportError'; this.code = code; }
}

const toBytes = input => input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;

function concat(chunks, size) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/**
 * Inflates `bytes` ('deflate-raw' for ZIP entries, 'deflate' for zlib-wrapped PDF streams). Output past `limit` bytes is
 * refused. A stream with a damaged tail keeps what it produced before the damage, since PDFs often pad their streams.
 */
export async function inflate(bytes, format = 'deflate-raw', limit = MAX_ENTRY_BYTES) {
  if (typeof DecompressionStream !== 'function') throw new ImportError('This browser cannot read compressed files.', 'unsupported');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { reader.cancel().catch(() => {}); throw new ImportError('A part of this file is too large to import.', 'too_large'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ImportError || !chunks.length) throw error instanceof ImportError ? error : new ImportError('A compressed part of this file is damaged.', 'damaged');
  }
  return concat(chunks, size);
}

/** readZip(bytes) -> { names, has(name), bytes(name), text(name) }. Names are matched exactly, then case-insensitively. */
export function readZip(input) {
  const data = toBytes(input);
  if (!data || data.length < 22) throw new ImportError('This file is not a valid document archive.', 'damaged');
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (u32(data, i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new ImportError('This file is not a valid document archive.', 'damaged');
  const count = u16(data, end + 10);
  const directory = u32(data, end + 16);
  if (directory === 0xffffffff || count === 0xffff) throw new ImportError('This archive is too large to import.', 'too_large');
  if (count > MAX_ENTRIES) throw new ImportError('This archive has too many parts to import.', 'too_large');
  const entries = new Map();
  let at = directory;
  for (let n = 0; n < count; n++) {
    if (at + 46 > data.length || u32(data, at) !== 0x02014b50) throw new ImportError('This document archive is damaged.', 'damaged');
    const flags = u16(data, at + 8), method = u16(data, at + 10), compressed = u32(data, at + 20), size = u32(data, at + 24);
    const nameLength = u16(data, at + 28), extra = u16(data, at + 30), comment = u16(data, at + 32), offset = u32(data, at + 42);
    const name = utf8.decode(data.subarray(at + 46, at + 46 + nameLength));
    if (!name.endsWith('/')) entries.set(name, { name, flags, method, compressed, size, offset });
    at += 46 + nameLength + extra + comment;
  }
  const lower = new Map([...entries.keys()].map(name => [name.toLowerCase(), name]));
  const find = name => entries.get(name) || entries.get(lower.get(String(name).toLowerCase()));
  async function bytes(name) {
    const entry = find(name);
    if (!entry) return null;
    if (entry.flags & 1) throw new ImportError('This document is password-protected. Remove the password and try again.', 'encrypted');
    const local = entry.offset;
    if (local + 30 > data.length || u32(data, local) !== 0x04034b50) throw new ImportError('This document archive is damaged.', 'damaged');
    const start = local + 30 + u16(data, local + 26) + u16(data, local + 28);
    const raw = data.subarray(start, start + entry.compressed);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflate(raw, 'deflate-raw', Math.min(MAX_ENTRY_BYTES, Math.max(entry.size, 1) * 2 + 1024));
    throw new ImportError('This document uses a compression method that cannot be read here.', 'unsupported');
  }
  return {
    names: [...entries.keys()],
    has: name => !!find(name),
    bytes,
    async text(name) { const value = await bytes(name); return value ? utf8.decode(value) : null; },
  };
}
