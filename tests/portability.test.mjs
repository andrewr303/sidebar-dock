import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullBackup, importPortableFile, exportBookmarkHtml, exportNotesMarkdown, parseCsv } from '../extension/lib/portability.js';
import { createLibraryStore } from '../extension/lib/store.js';

function adapter(seed = { schemaVersion: 1, items: [], collections: [], settings: {} }) {
  let library = structuredClone(seed), writes = 0, fileWrites = 0;
  const attachments = new Map();
  const core = createLibraryStore({ read: async () => library, write: async value => { library = value; writes++; } });
  return {
    store: {
      exportLibrary: () => core.dispatch('exportLibrary'), importLibrary: (value, options) => core.dispatch('importLibrary', [value, options]),
      async getAttachment(id) { return attachments.get(id); },
      async saveAttachment(file) {
        fileWrites++;
        const attachmentId = `restored_${fileWrites}`;
        attachments.set(attachmentId, { blob: file, name: file.name, mime: file.type });
        return { attachmentId, fileName: file.name, mime: file.type, size: file.size };
      },
      async deleteAttachment(id) { attachments.delete(id); },
    },
    attachments,
    get library() { return library; }, get writes() { return writes; }, get fileWrites() { return fileWrites; },
  };
}
const fixture = () => ({ schemaVersion: 1, items: [
  { id: 'source', type: 'article', title: 'Useful & lovely', url: 'https://example.com/?x=1&y=2', content: 'A note\nwith two lines', tags: ['design', 'ideas'], collectionId: 'nested', highlights: [{ id: 'h1', text: 'A highlighted line', note: 'A personal annotation', url: 'https://example.com' }], relatedIds: ['note'] },
  { id: 'note', type: 'note', title: 'My thoughts', content: '- [ ] Come back to this', collectionId: 'root', relatedIds: ['source', 'document'] },
  { id: 'document', type: 'file', title: 'Source file', attachmentId: 'original_file', fileName: 'evidence.bin', mime: 'application/octet-stream', size: 6, content: 'A binary source', relatedIds: ['note'] },
], collections: [{ id: 'root', name: 'Research & ideas', parentId: '' }, { id: 'nested', name: 'Deeper', parentId: 'root' }], settings: { theme: 'dark', apiToken: 'secret', nested: { credential: 'secret', density: 'compact' }, extras: [{ password: 'secret', label: 'safe' }] } });
// The library-only parts of a backup: other stores, snapshots and the device id are covered in tests/backup-*.test.mjs.
const isolated = { dashboard: null, conversations: null, aiConfig: null, snapshot: null, deviceId: null };
const jsonFile = value => new File([typeof value === 'string' ? value : JSON.stringify(value)], 'still-backup.json', { type: 'application/json' });
function portableFixture() {
  const value = fixture();
  value.attachments = [{ id: 'original_file', name: 'evidence.bin', mime: 'application/octet-stream', data: 'data:application/octet-stream;base64,AAH/fwoN' }];
  value.backupVersion = 1;
  return value;
}

test('complete backup round-trips binary files, nested collections, notes, highlights and connected item IDs', async () => {
  const source = adapter(fixture());
  const bytes = new Uint8Array([0, 1, 255, 127, 10, 13]);
  source.attachments.set('original_file', { blob: new Blob([bytes], { type: 'application/octet-stream' }), name: 'evidence.bin', mime: 'application/octet-stream' });
  const backup = await createFullBackup(source.store, isolated);
  assert.equal(backup.backupVersion, 2);
  assert.equal(backup.attachments.length, 1);
  assert.equal(backup.settings.apiToken, undefined);
  assert.deepEqual(backup.settings.nested, { density: 'compact' });
  assert.deepEqual(backup.settings.extras, [{ label: 'safe' }]);
  assert.equal(backup.items[0].highlights[0].note, 'A personal annotation');
  const target = adapter({ schemaVersion: 1, items: [{ id: 'existing', type: 'note', title: 'Keep me', content: 'Existing local work' }], collections: [], settings: { theme: 'light' } });
  const result = await importPortableFile(jsonFile(backup), target.store, isolated);
  assert.equal(result.items, 3);
  assert.equal(result.files, 1);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.library.items, { added: 3, updated: 0, kept: 0, tombstoned: 0 });
  assert.equal(target.library.items.find(item => item.id === 'existing').content, 'Existing local work');
  assert.equal(target.library.items.find(item => item.id === 'source').content, 'A note\nwith two lines');
  assert.equal(target.library.items.find(item => item.id === 'source').highlights[0].note, 'A personal annotation');
  assert.deepEqual(target.library.items.find(item => item.id === 'note').relatedIds, ['source', 'document']);
  const document = target.library.items.find(item => item.id === 'document');
  assert.equal(document.attachmentId, 'restored_1');
  assert.deepEqual(new Uint8Array(await target.attachments.get(document.attachmentId).blob.arrayBuffer()), bytes);
  assert.equal(target.library.collections.find(collection => collection.id === 'nested').parentId, 'root');
  // A full backup brings its settings back (secret-like keys never travel).
  assert.equal(result.settings, true);
  assert.equal(target.library.settings.theme, 'dark');
  assert.equal(target.library.settings.apiToken, undefined);
  assert.deepEqual(target.library.settings.nested, { density: 'compact' });
});

test('malformed IDs, URLs, prototype keys, MIME/base64, metadata sizes and cycles fail before any writes', async () => {
  const mutations = [
    data => { data.items[0].id = '../unsafe'; },
    data => { data.items[0].url = 'javascript:alert(1)'; },
    data => { data.items[0].url = 'https://user:password@example.com'; },
    data => { data.items.push({ ...data.items[0] }); },
    data => { data.items[0].cover = 'data:image/svg+xml;base64,PHN2Zz4='; },
    data => { data.items[0].type = 'unsupported'; },
    data => { data.items[0].relatedIds = ['../bad']; },
    data => { data.collections[0].parentId = 'nested'; },
    data => { data.attachments[0].data = 'data:application/octet-stream;base64,AB=='; },
    data => { data.attachments[0].mime = 'image/png'; },
    data => { data.attachments[0].name = '../escape.bin'; },
    data => { data.items[2].size = 9; },
    data => { data.items[2].mime = 'application/pdf'; },
    data => { data.attachments.push({ ...data.attachments[0] }); },
  ];
  for (const mutate of mutations) {
    const data = portableFixture(); mutate(data);
    const target = adapter();
    await assert.rejects(importPortableFile(jsonFile(data), target.store, isolated));
    assert.equal(target.fileWrites, 0); assert.equal(target.writes, 0); assert.equal(target.attachments.size, 0);
  }
  const target = adapter();
  await assert.rejects(importPortableFile(jsonFile('{"schemaVersion":1,"items":[],"collections":[],"settings":{"__proto__":{"polluted":true}}}'), target.store, isolated), /unsafe object key/);
  assert.equal({}.polluted, undefined);
  assert.equal(target.writes, 0);
});

test('import rolls back newly restored blobs when a later attachment or final library merge fails', async () => {
  const data = portableFixture();
  data.items.push({ id: 'second_file', type: 'file', title: 'Second', attachmentId: 'second', size: 1 });
  data.attachments.push({ id: 'second', name: 'second.bin', mime: 'application/octet-stream', data: 'data:application/octet-stream;base64,AA==' });
  const target = adapter();
  let saves = 0;
  const save = target.store.saveAttachment;
  target.store.saveAttachment = async file => { if (++saves === 2) throw new Error('Disk quota exceeded'); return save(file); };
  await assert.rejects(importPortableFile(jsonFile(data), target.store, isolated), /Disk quota/);
  assert.equal(target.attachments.size, 0); assert.equal(target.writes, 0);
  const original = adapter(fixture());
  const before = structuredClone(original.library);
  original.store.importLibrary = async () => { throw new Error('Library write failed'); };
  await assert.rejects(importPortableFile(jsonFile(portableFixture()), original.store, isolated), /Library write failed/);
  assert.equal(original.attachments.size, 0);
  assert.deepEqual(original.library, before);
});

test('legacy metadata-only imports explain missing bytes, never link to an unrelated local file by ID, and still back up', async () => {
  const target = adapter();
  target.attachments.set('original_file', { blob: new Blob(['Unrelated existing data']) });
  const result = await importPortableFile(jsonFile(fixture()), target.store, isolated);
  assert.equal(result.files, 0);
  assert.match(result.warnings[0], /metadata only/);
  const document = target.library.items.find(item => item.id === 'document');
  assert.match(document.attachmentId, /^missing_/);
  assert.notEqual(document.attachmentId, 'original_file');
  assert.equal(target.attachments.size, 1);
  // The missing file no longer blocks a full backup: the item travels without it and the manifest says so.
  const backup = await createFullBackup(target.store, isolated);
  assert.equal(backup.attachments.length, 0);
  assert.equal(backup.items.find(item => item.id === 'document').attachmentId, document.attachmentId);
  assert.match(backup.manifest.warnings.join(' '), /1 file could not be found/);
  const again = adapter();
  const restored = await importPortableFile(jsonFile(backup), again.store, isolated);
  assert.equal(restored.items, 3);
  assert.match(restored.warnings[0], /metadata only/);
});

test('CSV handles BOM, escaped quotes, commas and multiline notes; invalid later rows leave the library intact', async () => {
  const source = '\uFEFFurl,title,tags,note,excerpt\r\nhttps://example.com,"A ""quoted"", title","design; ideas","Line one\nLine two","An excerpt"\r\n';
  const target = adapter();
  const result = await importPortableFile(new File([source], 'bookmarks.csv'), target.store, isolated);
  assert.equal(result.items, 1);
  assert.equal(target.library.items[0].title, 'A "quoted", title');
  assert.equal(target.library.items[0].content, 'Line one\nLine two');
  assert.deepEqual(target.library.items[0].tags, ['design', 'ideas']);
  assert.equal(target.library.items[0].excerpt, 'An excerpt');
  const before = structuredClone(target.library);
  await assert.rejects(importPortableFile(new File(['url,title\nhttps://valid.example,Good\njavascript:alert(1),Bad'], 'bad.csv'), target.store, isolated), /CSV row 3/);
  assert.deepEqual(target.library, before);
  assert.throws(() => parseCsv('url,title\nhttps://example.com,"Unclosed'), /unclosed/);
  assert.throws(() => parseCsv('url,title\nhttps://example.com,"Closed"bad'), /closing quote/);
});

test('Netscape HTML preserves folders, URLs, tags and notes without importing scripts or unsafe schemes', async () => {
  const source = fixture();
  const html = exportBookmarkHtml(source);
  assert.match(html, /NETSCAPE-Bookmark-file-1/);
  assert.match(html, /Research &amp; ideas/);
  assert.match(html, /x=1&amp;y=2/);
  const target = adapter();
  const result = await importPortableFile(new File([html + '<script><a href="https://evil.example">Ignore</a></script><a href="javascript:alert(1)">Bad</a>'], 'bookmarks.html'), target.store, isolated);
  assert.equal(result.items, 1);
  assert.match(result.warnings[0], /Skipped 1/);
  assert.equal(target.library.items[0].title, 'Useful & lovely');
  assert.equal(target.library.items[0].content, 'A note\nwith two lines');
  assert.deepEqual(target.library.items[0].tags, ['design', 'ideas']);
  const nested = target.library.collections.find(collection => collection.name === 'Deeper');
  assert.equal(target.library.items[0].collectionId, nested.id);
  assert.equal(target.library.collections.find(collection => collection.id === nested.parentId).name, 'Research & ideas');
});

test('Markdown export includes standalone and source notes, annotations and connected item references', () => {
  const markdown = exportNotesMarkdown(fixture());
  assert.match(markdown, /## My thoughts/);
  assert.match(markdown, /- \[ \] Come back to this/);
  assert.match(markdown, /A highlighted line/);
  assert.match(markdown, /A personal annotation/);
  assert.match(markdown, /### Connected items/);
  assert.match(markdown, /Useful & lovely: <https:\/\/example.com/);
  assert.match(markdown, /Source file \(document\)/);
});

test('importing a backup sanitizes conversation.research so imported conversations cannot hijack local items on undo or subpage edits', async () => {
  const source = fixture();
  source.conversations = {
    schemaVersion: 1,
    conversations: [{
      id: 'conv_research',
      title: 'Imported research',
      mode: 'research',
      targetId: 'article',
      createdAt: '2026-04-08T10:00:00.000Z',
      updatedAt: '2026-04-08T10:05:00.000Z',
      research: {
        status: 'running',
        itemId: 'article',
        sessionId: 'sesn_remote',
        connectionId: 'anthropic:remote',
        ownerId: 'owner_remote',
        allowOriginalEdits: true,
        budgetCents: 100,
        spentCents: 25,
        pages: [{ id: 'note', title: 'Target local note' }],
        undo: {
          originalField: 'content',
          originalText: 'INJECTED CONTENT',
          originalWritten: 'A note\nwith two lines',
          subpageIds: ['note'],
        },
      },
      messages: [{
        id: 'msg_1',
        role: 'assistant',
        text: 'Summary',
        createdAt: '2026-04-08T10:05:00.000Z',
        research: { status: 'running', sessionId: 'sesn_remote', live: true, steps: [{ id: 's1', kind: 'search', label: 'Searched', status: 'done' }] },
      }],
    }],
  };
  let importedPayload = null;
  const target = adapter();
  await importPortableFile(jsonFile(source), target.store, {
    ...isolated,
    conversations: { importAll: async value => { importedPayload = value; } },
  });
  const imported = importedPayload.conversations.find(entry => entry.id === 'conv_research');
  assert.ok(imported);
  assert.equal(imported.research.status, 'stopped', 'running research is clamped to stopped on import');
  assert.equal(imported.research.undo, undefined, 'undo state is stripped on import');
  assert.equal(imported.research.allowOriginalEdits, undefined, 'allowOriginalEdits is stripped on import');
  assert.equal(imported.research.sessionId, undefined, 'remote sessionId is stripped on import');
  assert.equal(imported.research.connectionId, undefined, 'remote connectionId is stripped on import');
  assert.equal(imported.research.pages[0].imported, true, 'imported pages are marked imported');
  assert.equal(imported.messages[0].research.live, false);
  assert.equal(imported.messages[0].research.sessionId, undefined);
});

