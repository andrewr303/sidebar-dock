// WORKSTREAM-STUB(sd-link): contract placeholder. The sd-link workstream replaces this with the full protocol module
// (envelopes, validators, sanitizers). threadHash/chatItemId/threadCiteId are final and must not change.
export const PROTO = 'still-threadkeeper/1';
const MASK = 0xffffffffffffffffn;
function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(String(text))) { hash ^= BigInt(byte); hash = (hash * 0x100000001b3n) & MASK; }
  return hash.toString(16).padStart(16, '0');
}
/** 32 lowercase hex chars; identical to Threadkeeper's threadHash. */
export const threadHash = threadKey => fnv1a64(threadKey) + fnv1a64(`still:${threadKey}`);
export const chatItemId = threadKey => `chat_tk_${threadHash(threadKey)}`;
export const threadCiteId = threadKey => `tk:${threadHash(threadKey).slice(0, 16)}`;
export const isExtensionId = value => typeof value === 'string' && /^[a-p]{32}$/.test(value);
export class ThreadkeeperError extends Error {
  constructor(code, message) { super(message || code); this.name = 'ThreadkeeperError'; this.code = code; }
}
