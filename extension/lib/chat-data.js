// WORKSTREAM-STUB(sd-data): contract placeholder committed so parallel workstreams can import it.
// The sd-data workstream replaces this file with the real IndexedDB store (still.chats.v1). See
// docs/threadkeeper-integration.md and the design notes for the full contract.
export const CHAT_DB = 'still.chats.v1';
const memory = { records: new Map(), transcripts: new Map() };
/** createChatDataStore({ indexedDB }) → { put, get, getTranscript, delete, ids, stats, clear } */
export function createChatDataStore() {
  return {
    async put(id, { thread, transcript = null } = {}) { memory.records.set(id, { id, threadKey: thread?.threadKey || '', fingerprint: thread?.fingerprint || '', revision: thread?.revision || 0, storedAt: new Date().toISOString(), thread }); if (transcript) memory.transcripts.set(id, { id, ...transcript }); },
    async get(id) { return memory.records.get(id) || null; },
    async getTranscript(id) { return memory.transcripts.get(id) || null; },
    async delete(ids) { let n = 0; for (const id of [].concat(ids || [])) { if (memory.records.delete(id)) n++; memory.transcripts.delete(id); } return n; },
    async ids() { return [...memory.records.keys()]; },
    async stats() { return { chats: memory.records.size, transcripts: memory.transcripts.size, bytes: 0 }; },
    async clear() { memory.records.clear(); memory.transcripts.clear(); },
  };
}
const shared = createChatDataStore();
export const putChatData = (id, data) => shared.put(id, data);
export const getChatRecord = id => shared.get(id);
export const getChatTranscript = id => shared.getTranscript(id);
export const deleteChatData = ids => shared.delete(ids);
export const listChatDataIds = () => shared.ids();
export const chatDataStats = () => shared.stats();
