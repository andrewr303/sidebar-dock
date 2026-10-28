import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNoteBlocks,serializeNoteBlocks,serializeBlockParts,listNumbers} from '../extension/lib/markdown.js';
import {SEED_LIBRARY} from '../extension/lib/seed.js';
import {noteTemplates} from '../extension/lib/notes.js';

const brief=md=>parseNoteBlocks(md).map(b=>[b.type,b.indent,b.text,b.kind,b.ordinal].filter(x=>x!==undefined));
const block=(type,text,extra={})=>({id:String(Math.random()),type,text,checked:false,language:'',...extra});
const stable=blocks=>{const once=serializeNoteBlocks(blocks);assert.equal(serializeNoteBlocks(parseNoteBlocks(once)),once,'re-serializing a parsed result changes nothing');return once;};

test('untouched notes re-serialize byte for byte, including the new syntax and legacy forms',()=>{
 const corpus=[
  '# T\n\n> [!NOTE] legacy callout\n> plain quote','- a\n  - b\n* c\n+ d','1) x\n2) y','line\\\ncontinued\\\n- not list',
  '> [!TIP]\n> one\n>\n> two\n\n> [!WARNING]','```\n- [ ] x\n```\n- [ ] y','\t- tab\n\t\t- tabtab','a  \nb','- a\n    - four spaces\n - one space',
  '10. ten\n    - deep\n11. eleven','> q\n> [!CAUTION]\n> c','| a |\n| - |\n| 1 |\nafter','x\r\n- y\r\n  - z\r\n',
  '| a |\n| - |\n| 1 |\n+ d','| a |\n| - |\n| 1 |\n***','| a | b |\n| - | - |\n- a | b\n--- | ---\n| x | y |',
  ...SEED_LIBRARY.items.map(item=>item.content||'').filter(Boolean),...noteTemplates(new Date(2026,9,28)).map(t=>t.content)
 ];
 for(const source of corpus)assert.equal(serializeNoteBlocks(parseNoteBlocks(source)),source,JSON.stringify(source));
});

test('list items nest by indentation relative to their parent marker',()=>{
 assert.deepEqual(brief('- a\n  - b\n\t- c\n    - d\n- e'),[['bullet',0,'a'],['bullet',1,'b'],['bullet',2,'c'],['bullet',2,'d'],['bullet',0,'e']]);
 assert.deepEqual(brief('1. one\n   - sub\n2. two\n10. ten\n    - deep'),[['number',0,'one',1],['bullet',1,'sub'],['number',0,'two',2],['number',0,'ten',10],['bullet',1,'deep']]);
 assert.deepEqual(brief('- a\n - b'),[['bullet',0,'a'],['bullet',0,'b']],'one space is not enough to nest');
 assert.deepEqual(brief('- [ ] t\n  - [X] u'),[['todo',0,'t'],['todo',1,'u']]);
 assert.equal(parseNoteBlocks('- [ ] t\n  - [X] u')[1].checked,true);
});

test('changing a list level re-indents under the parent content column; untouched items keep their lead',()=>{
 let b=parseNoteBlocks('- a\n  - b\n- c');b[1].indent=0;assert.equal(serializeNoteBlocks(b),'- a\n- b\n- c');
 b=parseNoteBlocks('- a\n- b');b[1].indent=1;assert.equal(serializeNoteBlocks(b),'- a\n  - b');
 b=parseNoteBlocks('1. a\n2. b');b[1].indent=1;assert.equal(serializeNoteBlocks(b),'1. a\n   2. b','the first item of a nested list keeps its own number as the start');
 b[1].ordinal=1;assert.equal(serializeNoteBlocks(b),'1. a\n   1. b');
 b=parseNoteBlocks('10. a\n11. b');b[1].indent=1;b[1].type='bullet';assert.equal(serializeNoteBlocks(b),'10. a\n    - b');
 b=parseNoteBlocks('- a\n    - b');b[1].text='B';assert.equal(serializeNoteBlocks(b),'- a\n    - B','an edited item keeps its own indentation at the same level');
 b=[block('bullet','a',{indent:0}),block('bullet','b',{indent:3})];assert.equal(stable(b),'- a\n  - b','levels deeper than the previous item clamp to one below it');
});

test('list numbering counts per level and restarts after other blocks',()=>{
 assert.deepEqual(listNumbers(parseNoteBlocks('3. a\n4. b\n   1. x\n   2. y\n5. c\n\n1. z')),[3,4,1,2,5,null,1]);
 const b=parseNoteBlocks('3. a\n4. b\n5. c');b.splice(1,1);assert.equal(serializeNoteBlocks(b),'3. a\n5. c','untouched items keep their raw numbers');
 b[1].text='c!';assert.equal(serializeNoteBlocks(b),'3. a\n4. c!','an edited item is renumbered');
});

test('newlines in text blocks become hard breaks, escaping continuation lines that would start a block',()=>{
 const source=stable([block('paragraph','a\nb\n- c\n# d\n> e\n1. f\n---\n```')]);
 assert.equal(source,'a\\\nb\\\n\\- c\\\n\\# d\\\n\\> e\\\n1\\. f\\\n\\---\\\n\\```');
 assert.equal(parseNoteBlocks(source).length,1,'still one block after reopening');
 assert.equal(stable([block('bullet','a\nb',{indent:0}),block('number','x\ny',{indent:1,ordinal:1})]),'- a\\\n  b\n  1. x\\\n     y');
 assert.deepEqual(brief('- a\\\n  b\n  1. x\\\n     y'),[['bullet',0,'a\nb'],['number',1,'x\ny',1]]);
 assert.equal(stable([block('h2','a\nb')]),'## a b','headings stay on one line');
 assert.equal(stable([block('paragraph','ends with a slash\\')]),'ends with a slash\\');
});

test('text that looks like syntax is escaped so the block keeps its type',()=>{
 assert.equal(stable([block('paragraph','# not heading'),block('paragraph','> no'),block('paragraph','  - no'),block('paragraph',':::toggle x')]),'\\# not heading\n\\> no\n  \\- no\n\\:::toggle x');
 assert.deepEqual(brief('\\# not heading\n\\> no'),[['paragraph','\\# not heading'],['paragraph','\\> no']]);
 assert.equal(stable([block('bullet','[ ] not a task',{indent:0})]),'- \\[ ] not a task');
 assert.equal(parseNoteBlocks('- \\[ ] not a task')[0].type,'bullet');
});

test('callouts serialize as GitHub alerts with their kind; quotes keep multi-line bodies',()=>{
 const source=stable([block('callout','line1\nline2',{kind:'warning'}),block('callout','',{kind:'tip'}),block('callout','[!x] y',{kind:'unknown'})]);
 assert.equal(source,'> [!WARNING]\n> line1\n> line2\n> [!TIP]\n> [!NOTE]\n> \\[!x] y');
 assert.deepEqual(brief(source),[['callout','line1\nline2','warning'],['callout','','tip'],['callout','\\[!x] y','note']]);
 assert.equal(serializeNoteBlocks([block('quote','a\n\nb'),block('quote','c')]),'> a\n>\n> b\n\n> c','adjacent quotes are separated so they stay two quotes');
 assert.deepEqual(brief('> a\n>\n> b\n\n> c').filter(b=>b[0]==='quote'),[['quote','a\n\nb'],['quote','c']]);
 const legacy=parseNoteBlocks('> [!NOTE] Careful');legacy[0].text='Edited';assert.equal(serializeNoteBlocks(legacy),'> [!NOTE]\n> Edited','an edited legacy callout is rewritten in the GitHub form');
});

test('a table followed by text keeps a blank line so the text is not read as a row',()=>{
 const table={id:'t',type:'table',text:'',headers:['A'],rows:[['1']],alignments:[]};
 assert.equal(serializeNoteBlocks([table,block('paragraph','after')]),'| A |\n| --- |\n| 1 |\n\nafter');
 assert.deepEqual(serializeBlockParts([table,block('paragraph','after')]),['| A |\n| --- |\n| 1 |','\nafter'],'the separating blank line belongs to the following part');
});
