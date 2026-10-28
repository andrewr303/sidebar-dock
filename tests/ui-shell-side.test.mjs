import test from 'node:test';
import assert from 'node:assert/strict';
import { sideHeaderShown, sideTabPatch } from '../extension/ui/shell.js';

const side = (patch = {}) => ({ panel: null, sideTab: 'page', sideStack: [], notes: { scope: 'all', collectionId: '', noteId: null, query: '' }, ...patch });

test('the side panel header steps aside for screens that draw their own header row', () => {
  assert.equal(sideHeaderShown(side()), true, 'This page');
  assert.equal(sideHeaderShown(side({ sideTab: 'library' })), true, 'Library root');
  assert.equal(sideHeaderShown(side({ sideTab: 'library', sideStack: ['collection:design'] })), false, 'Library drill-down');
  assert.equal(sideHeaderShown(side({ sideTab: 'notes' })), true, 'notes list');
  assert.equal(sideHeaderShown(side({ sideTab: 'notes', notes: { noteId: 'n1' } })), false, 'open note');
  assert.equal(sideHeaderShown(side({ sideTab: 'ask' })), false, 'assistant');
  assert.equal(sideHeaderShown(side({ panel: { kind: 'ai' } })), false, 'assistant panel');
  assert.equal(sideHeaderShown(side({ panel: { kind: 'item', id: 'a' } })), false, 'item detail');
  assert.equal(sideHeaderShown(side({ sideTab: 'notes', notes: null })), true, 'notes state not created yet');
});

test('tapping the active side tab returns it to its root; other taps switch tabs and close a covering panel', () => {
  const editing = side({ sideTab: 'notes', notes: { scope: 'page', noteId: 'n1', returnTo: 'page', query: 'trip' } });
  assert.deepEqual(sideTabPatch(editing, 'notes'), { panel: null, sideTab: 'notes', notes: { scope: 'page', noteId: null, returnTo: '', query: 'trip' } },
    'an open note closes to the list (not to the tab it came from), keeping the list filters');
  assert.deepEqual(sideTabPatch(editing, 'page'), { panel: null, sideTab: 'page' }, 'another tab leaves the note open for later');
  assert.deepEqual(sideTabPatch(side({ sideTab: 'notes' }), 'notes'), { panel: null, sideTab: 'notes' }, 'the list stays the list');
  assert.deepEqual(sideTabPatch(side({ sideTab: 'library', sideStack: ['collection:design'] }), 'library'), { panel: null, sideTab: 'library', sideStack: [] });
  assert.deepEqual(sideTabPatch(side({ sideTab: 'library', sideStack: ['inbox'] }), 'notes'), { panel: null, sideTab: 'notes' });
  const covered = side({ sideTab: 'notes', notes: { noteId: 'n1' }, panel: { kind: 'item', id: 'a' } });
  assert.equal(sideTabPatch(covered, 'notes').notes.noteId, null, 'detail opened from a note: the Notes tab goes back to its list');
  assert.deepEqual(sideTabPatch(side({ sideTab: 'notes', notes: { noteId: 'n1' }, panel: { kind: 'ai' } }), 'notes'), { panel: null, sideTab: 'notes' },
    'with the assistant showing, Notes is not the active tab, so the note stays open');
});
