// WORKSTREAM-STUB(sd-link): contract placeholder so UI, settings and assistant workstreams can import the page client.
// The sd-link workstream replaces this file. Every function keeps exactly this name and signature.
import { ThreadkeeperError } from './protocol.js';
const unavailable = () => new ThreadkeeperError('unavailable', 'Threadkeeper works when Still runs as an extension.');
const OFF = Object.freeze({ version: 1, extensionId: '', status: 'off', pending: null, tk: { version: '', capabilities: [] },
  pairedAt: '', lastSeenAt: '', lastSyncAt: '', lastError: '', lastErrorAt: '', counts: { created: 0, updated: 0, removed: 0 },
  prefs: { scope: 'all', projects: [], providers: [], transcripts: true, autoUpdate: true, placement: 'mirror', parentName: 'AI chats',
    singleCollectionId: '', matchExisting: true, topicsAsTags: false, onRemoved: 'keep', defaultView: 'summary',
    assistant: { search: true, context: 'auto', decision: true } } });
export async function getThreadkeeperState() { return structuredClone(OFF); }
export function onThreadkeeperChange() { return () => {}; }
export async function discoverThreadkeeper() { return []; }
export async function connectThreadkeeper() { throw unavailable(); }
export async function disconnectThreadkeeper() { throw unavailable(); }
export async function setThreadkeeperPrefs() { throw unavailable(); }
export async function syncThreadkeeperNow() { throw unavailable(); }
export async function threadkeeperRequest() { throw unavailable(); }
export async function importThreadkeeperThreads() { throw unavailable(); }
export async function refreshChat() { throw unavailable(); }
export async function loadTranscriptWindow() { throw unavailable(); }
export const isThreadkeeperReady = state => state?.status === 'paired';
