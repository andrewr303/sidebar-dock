// Export for DayDock: the one file DayDock's import page reads when a library moves from this extension to a DayDock
// account. It is a full backup (lib/portability.js, backupVersion 2) without the parts DayDock does not import
// (assistant chats, AI connections, AI chat summaries and transcripts), plus a marker right after the manifest:
//   daydock: { exportVersion: 1, exportedFor: 'daydock', source: 'still-extension' }
// Still's own import ignores the marker, so the file also restores here like any backup. The backup's limits, repairs
// and warnings apply unchanged (manifest.warnings). Pure: no DOM and no network; nothing here uploads anything.
import { createFullBackup, backupSource } from './portability.js';

export const DAYDOCK_IMPORT_URL = 'https://daydock.tech/library/import';
export const DAYDOCK_EXPORT_VERSION = 1;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

/**
 * The export file as an object; download serializeBackup(backup).text. options are createFullBackup's (dashboard source,
 * deviceId, extensionVersion, maxBytes); assistant chats, AI connections and AI chat data are always left out. Throws
 * only when the library cannot be read.
 */
export async function createDayDockExport(store, options = {}) {
  const backup = await createFullBackup(store, { ...options, conversations: null, aiConfig: null, chatData: null });
  const { backupVersion, schemaVersion, exportedAt, manifest, ...library } = backup;
  return { backupVersion, schemaVersion, exportedAt, manifest,
    daydock: { exportVersion: DAYDOCK_EXPORT_VERSION, exportedFor: 'daydock', source: 'still-extension' }, ...library };
}

/**
 * What the export leaves in this extension, counted from the stores a full backup would read (options replaces a source
 * or turns it off with null, as in createFullBackup): { conversations, aiConnections, chatTranscripts }. A store that
 * cannot be read counts as null.
 */
export async function countLeftBehind(backup, options = {}) {
  const read = async (key, count) => {
    try {
      const source = await backupSource(options, key);
      return source ? await count(source) : 0;
    } catch { return null; }
  };
  const chatIds = new Set(list(backup?.items).filter(item => item?.type === 'chat').map(item => item.id));
  return {
    // From the index (listConversations), so no conversation body is loaded just to be counted.
    conversations: await read('conversations', async source => (source.listConversations ? list(await source.listConversations()).filter(isObject).length : 0)),
    aiConnections: await read('aiConfig', async source => (source.exportAiConfig ? list((await source.exportAiConfig())?.connections).length : 0)),
    chatTranscripts: chatIds.size ? await read('chatData', async source => (source.list
      ? list(await source.list()).filter(record => isObject(record) && chatIds.has(record.id) && record.transcript).length : 0)) : 0,
  };
}

// Decoded size of a 'data:<mime>;base64,…' value, from its length.
function dataBytes(data) {
  const base64 = typeof data === 'string' ? data.slice(data.indexOf(',') + 1) : '';
  return Math.max(0, base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0));
}

/**
 * Plain numbers for the UI. From the file: saves (items that are not notes), notes, collections, highlights, boards,
 * widgets, files (item files; the wallpaper image is a setting) with fileBytes, trash (items in Trash, counted in saves
 * and notes too), deleted (tombstones) and the backup's warnings. `left` names what stays in this extension, in words
 * for a sentence; pass countLeftBehind's result to give the numbers.
 */
export function summarizeDayDockExport(backup, stays = {}) {
  const items = list(backup?.items), boards = list(backup?.dashboard?.boards);
  const files = list(backup?.attachments).filter(entry => isObject(entry) && entry.ref !== 'wallpaper');
  // null: that store could not be read, so the line stays without a number.
  const counted = (count, word) => (count === null ? `${word}s` : count > 0 ? plural(count, word) : '');
  return {
    saves: items.filter(item => item.type !== 'note').length,
    notes: items.filter(item => item.type === 'note').length,
    collections: list(backup?.collections).length,
    highlights: items.reduce((sum, item) => sum + list(item.highlights).length, 0),
    boards: boards.length,
    widgets: boards.reduce((sum, board) => sum + list(board?.widgets).length, 0),
    files: files.length,
    fileBytes: files.reduce((sum, entry) => sum + dataBytes(entry.data), 0),
    trash: items.filter(item => item.deletedAt).length,
    deleted: list(backup?.tombstones).length,
    warnings: list(backup?.manifest?.warnings).slice(),
    left: [counted(stays.conversations, 'assistant conversation'), counted(stays.aiConnections, 'AI connection'),
      counted(stays.chatTranscripts, 'AI chat transcript'), 'settings and wallpaper', 'connected accounts and API keys'].filter(Boolean),
  };
}

/** still-for-daydock-YYYY-MM-DD.json (the UTC date, like the other downloads). */
export function dayDockExportFileName(date = new Date()) {
  const when = new Date(date);
  return `still-for-daydock-${(Number.isNaN(when.getTime()) ? new Date() : when).toISOString().slice(0, 10)}.json`;
}
