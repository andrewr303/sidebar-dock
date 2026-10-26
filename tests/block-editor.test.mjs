import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdown,serializeBlocks,findBlockCommands,serializeInlineFragment} from '../extension/lib/block-editor.js';
test('existing notes round trip through blocks without losing markdown, blanks, tasks or code',()=>{
 const value='# An idea\n\n**Keep this** and *that*.\n- [x] Done\n- [ ] Next\n> A source\n\n```js\nconst x = 12;\nconsole.log(x);\n```\n---';
 assert.equal(serializeBlocks(parseMarkdown(value)),value);
});
test('block edits preserve task completion and ordered list structure',()=>{
 const b=parseMarkdown('1. First\n2. Next\n\n- [ ] Remember');b.at(-1).checked=true;b[0].text='New first';
 assert.equal(serializeBlocks(b),'1. New first\n2. Next\n\n- [x] Remember');
});
test('slash menu recognizes familiar task and heading aliases despite human-readable punctuation',()=>{assert.equal(findBlockCommands('/todo')[0][0],'todo');assert.equal(findBlockCommands('to-do')[0][0],'todo');assert.equal(findBlockCommands('/h2')[0][0],'h2');assert.equal(findBlockCommands('/number')[0][0],'number');});

const text=value=>({nodeType:3,textContent:value});
const element=(tagName,...childNodes)=>({nodeType:1,tagName,childNodes});
const fragment=(...childNodes)=>({nodeType:11,childNodes});
test('split DOM fragments preserve emphasis while keeping edge whitespace outside Markdown markers',()=>{
 const prefix=fragment(element('STRONG',text('Keep')));
 assert.equal(serializeInlineFragment(prefix),'**Keep**');
 assert.equal(serializeInlineFragment(fragment(element('STRONG',text(' this')),text(' and '),element('EM',text('that')),text('.'))),' **this** and *that*.');
 assert.equal(serializeInlineFragment(fragment(element('EM',text(' th ')))),' *th* ');
});
test('empty partial markup does not become empty emphasis or code delimiters',()=>{
 assert.equal(serializeInlineFragment(fragment(element('STRONG'),element('EM'),element('CODE'))),'');
 assert.equal(serializeInlineFragment(fragment(element('STRONG',text(' ')),element('EM',text('\t')))),' \t');
 assert.equal(serializeInlineFragment(fragment(element('CODE',text('code')))),'`code`');
});
