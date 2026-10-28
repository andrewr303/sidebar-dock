import test from 'node:test';
import assert from 'node:assert/strict';
import {extractTasks,toggleTask,taskProgress,extractWikiLinks,resolveWikiLinks,linkResolver,noteExcerpt,noteTitleFromContent,outline,wordCount,notesForPage,noteTemplates,dailyNoteTitle} from '../extension/lib/notes.js';
import {renderMarkdown,TASK_LINE,taskLineIndices} from '../extension/lib/markdown.js';

const LEXICAL='```md\n- [ ] literal code\n```\n- [x] Outside\n::::toggle [open] More\n- [ ] Inside\n```\n- [ ] literal nested code\n```\n:::toggle [closed] Nested\n- [ ] Deep\n:::\n::::\n- [ ] After\n  - [X] Nested **child**\n- [ ]\n- [ ]no space is a bullet';

test('task indices follow the shared lexical TASK_LINE rule used by data-task-index',()=>{
 assert.equal(TASK_LINE.test('  - [x] indented'),true);assert.equal(TASK_LINE.test('- [ ]'),true);assert.equal(TASK_LINE.test('- [ ]\r'),true);
 assert.equal(TASK_LINE.test('- [ ]x'),false);assert.equal(TASK_LINE.test('+ [ ] plus'),false);assert.equal(TASK_LINE.test('\\- [ ] escaped'),false);
 assert.deepEqual(taskLineIndices('a\n- [ ] b\n  - [x] c\ntext').filter(n=>n!==null),[0,1]);
 const tasks=extractTasks(LEXICAL);
 assert.deepEqual(tasks.map(t=>[t.index,t.plain,t.done,t.line,t.indent]),[[1,'Outside',true,3,0],[2,'Inside',false,5,0],[4,'Deep',false,10,0],[5,'After',false,13,0],[6,'Nested child',true,14,1],[7,'',false,15,0]]);
 const rendered=[...renderMarkdown(LEXICAL,{interactiveTasks:true}).matchAll(/data-task-index="(\d+)"/g)].map(m=>Number(m[1]));
 assert.deepEqual(rendered,tasks.map(t=>t.index));
 assert.equal(tasks[4].text,'Nested **child**');
});
test('toggleTask rewrites only the indexed checkbox and keeps every other byte',()=>{
 const source='Intro\r\n- [ ] One\r\n```\n- [ ] code\n```\n  * [X] Two\n- [ ] Three';
 assert.equal(toggleTask(source,0,true),'Intro\r\n- [x] One\r\n```\n- [ ] code\n```\n  * [X] Two\n- [ ] Three');
 assert.equal(toggleTask(source,2,false),'Intro\r\n- [ ] One\r\n```\n- [ ] code\n```\n  * [ ] Two\n- [ ] Three');
 assert.equal(toggleTask(source,2,true),source,'already done keeps its X');
 assert.equal(toggleTask(source,3),'Intro\r\n- [ ] One\r\n```\n- [ ] code\n```\n  * [X] Two\n- [x] Three','omitting done flips the state');
 assert.equal(toggleTask(source,9,true),source);
 const html=renderMarkdown(toggleTask(LEXICAL,7,true),{interactiveTasks:true});assert.match(html,/data-task-index="7" checked/);
});
test('taskProgress counts real tasks only',()=>{assert.deepEqual(taskProgress(LEXICAL),{done:2,total:6});assert.deepEqual(taskProgress(''),{done:0,total:0});});

test('wiki links are extracted outside code, deduplicated, and resolved by id then title',()=>{
 const md='See [[Alpha]] and [[item_2|the second]].\n`[[Code]]` and \\[[Escaped]]\n```\n[[Fenced]]\n```\n| [[Cell]] |\n| --- |\n:::toggle [open] [[Title link]]\n[[Alpha]] again\n:::';
 assert.deepEqual(extractWikiLinks(md),['Alpha','item_2','Cell','Title link']);
 const items=[{id:'item_1',type:'note',title:'alpha',updatedAt:'2026-01-01'},{id:'item_9',type:'bookmark',title:'Alpha',updatedAt:'2026-09-01'},{id:'item_2',type:'note',title:'Second',updatedAt:'2026-01-02'},{id:'item_3',type:'note',title:'Cell',deletedAt:'2026-02-01'}];
 assert.deepEqual(resolveWikiLinks(md,items),[{title:'Alpha',id:'item_1'},{title:'item_2',id:'item_2'},{title:'Cell',id:null},{title:'Title link',id:null}]);
 const resolve=linkResolver(items);assert.deepEqual(resolve('ALPHA'),{id:'item_1',title:'alpha',type:'note'});assert.equal(resolve('missing'),null);
 const html=renderMarkdown('[[Alpha]] [[item_2]] [[item_2|Label]] [[Gone]]',{resolveLink:resolve});
 assert.match(html,/<a class="note-link" href="#" data-id="item_1" data-type="note" data-target="Alpha"/);
 assert.match(html,/data-id="item_2"[^>]*>Second<\/a>/,'a bare id shows the resolved title');
 assert.match(html,/data-label="Label"[^>]*>Label<\/a>/);
 assert.match(html,/<span class="note-link is-missing" data-target="Gone"/);
});

test('excerpt, title, outline and word count read rendered text, not Markdown syntax',()=>{
 const md='# Weekly **review**\n\nSome _text_ with [a link](https://example.com) and [[Alpha|a note]].\n- [ ] Ship it\n```js\nconst x = 1;\n```\n## Next steps\n### Details';
 assert.equal(noteTitleFromContent(md),'Weekly review');
 assert.equal(noteTitleFromContent('\n\n- first item\n# later'),'first item');
 assert.equal(noteTitleFromContent(''),'');
 assert.equal(noteExcerpt(md),'Weekly review Some text with a link and a note. Ship it const x = 1; Next steps Details');
 const long=noteExcerpt('word '.repeat(100),40);assert.ok(long.length<=41);assert.match(long,/word…$/);
 assert.deepEqual(outline(md),[{level:1,text:'Weekly review',line:0},{level:2,text:'Next steps',line:7},{level:3,text:'Details',line:8}]);
 assert.equal(wordCount(md),18);
 assert.equal(wordCount("It's a well-known fact. 东京 OK"),7,'each CJK character counts as a word');
 assert.equal(wordCount(''),0);
});

test('notesForPage matches canonical URLs and orders pinned, then newest',()=>{
 const items=[
  {id:'a',type:'note',url:'https://example.com/post?utm_source=x#top',updatedAt:'2026-10-01'},
  {id:'b',type:'note',url:'https://example.com/post/',updatedAt:'2026-10-03'},
  {id:'c',type:'note',url:'https://example.com/post',updatedAt:'2026-09-01',pinned:true},
  {id:'d',type:'bookmark',url:'https://example.com/post',updatedAt:'2026-10-05'},
  {id:'e',type:'note',url:'https://example.com/post',deletedAt:'2026-10-06'},
  {id:'f',type:'note',url:'https://example.com/other'},
  {id:'g',type:'note',url:''}
 ];
 assert.deepEqual(notesForPage(items,'https://example.com/post#section').map(i=>i.id),['c','b','a']);
 assert.deepEqual(notesForPage(items,'not a url'),[]);
});

test('templates and daily note titles are plain and parse into blocks',()=>{
 const now=new Date(2026,9,28,9,30);
 assert.equal(dailyNoteTitle(now,'en-US'),'Wed, Oct 28, 2026');
 assert.equal(dailyNoteTitle('not a date','en-US'),dailyNoteTitle(new Date(),'en-US'),'an invalid date falls back to today instead of throwing');
 const templates=noteTemplates(now,{page:{url:'https://example.com/a',title:'  An  article '}});
 assert.deepEqual(templates.map(t=>t.id),['blank','daily','meeting','reading','project']);
 const reading=templates.find(t=>t.id==='reading');assert.equal(reading.title,'Notes on An article');assert.equal(reading.url,'https://example.com/a');assert.match(reading.content,/^Source: https:\/\/example.com\/a\n/);
 assert.equal(templates.find(t=>t.id==='daily').title,'Wed, Oct 28, 2026');
 assert.equal(noteTemplates(now).find(t=>t.id==='reading').title,'Reading notes');
 for(const t of templates)assert.doesNotMatch(t.label+t.title+t.content,/—|!/);
 assert.equal(taskProgress(templates.find(t=>t.id==='project').content).total,1);
});
