import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdown,serializeBlocks,findBlockCommands,serializeInlineFragment} from '../extension/lib/block-editor.js';
import {renderMarkdown,renderInline,renderTableCell,safeMarkdownUrl,splitTableRow,isTableDivider,tableWidth,createTableBlock,serializeTable,updateTableCell,insertTableRow,removeTableRow,insertTableColumn,removeTableColumn,tableCellPosition,createToggleBlock,serializeToggle} from '../extension/lib/markdown.js';

test('untouched imported Markdown preserves exact list markers, escapes, whitespace and fences',()=>{
 for(const source of ['* One\n* Two\n\n3. Third\n4. Fourth\n','~~~typescript\n<script>literal</script>\n~~~~','```not-closed\nkeep\n','### Title\n\\*literal\\* and __bold__\n\n','A\r\n\r\n* [X] Imported\r\n',':::toggle [closed] Details\n\n:::'])assert.equal(serializeBlocks(parseMarkdown(source)),source);
});
test('editing a numbered import keeps its starting number in both source and preview',()=>{
 const blocks=parseMarkdown('3. Third\n4. Fourth');blocks[1].text='Revised fourth';assert.equal(serializeBlocks(blocks),'3. Third\n4. Revised fourth');assert.match(renderMarkdown(serializeBlocks(blocks)),/<ol start="3">/);
});
test('GFM tables recognize optional edge pipes, alignment and single-hyphen delimiters',()=>{
 const source='| left | center | right |\n| :- | :-: | -: |\n| one | two | three |';
 const [table]=parseMarkdown(source);assert.equal(table.type,'table');assert.deepEqual(table.alignments,['left','center','right']);assert.deepEqual(table.rows,[['one','two','three']]);assert.equal(serializeBlocks([table]),source);
 assert.equal(isTableDivider('--- | :---:'),true);assert.equal(isTableDivider('--- | text'),false);
 assert.equal(parseMarkdown('A | B\n---')[0].type,'paragraph');
});
test('table parsing preserves escaped pipes, backslashes, inline code and surplus body cells',()=>{
 const source=['A | B','--- | ---',String.raw`**one\|two** | \path\\name`,'\\|literal\\| | `a\\|b` | extra'].join('\n');
 const [table]=parseMarkdown(source);assert.equal(tableWidth(table),3);assert.equal(table.rows[0][0],String.raw`**one\|two**`);assert.equal(table.rows[0][1],String.raw`\path\\name`);assert.equal(table.rows[1][2],'extra');assert.equal(serializeBlocks([table]),source);
 const edited=updateTableCell(table,0,0,String.raw`**new\|kept**`);const portable=serializeTable(edited),[reopened]=parseMarkdown(portable);assert.equal(reopened.headers.length,3);assert.deepEqual(reopened.rows,edited.rows.map(r=>Array.from({length:3},(_,i)=>r[i]??'')));assert.match(renderMarkdown(portable),/<strong>new\|kept<\/strong>/);assert.match(renderMarkdown(portable),/<code>a\|b<\/code>/);
});
test('unmatched backticks cannot swallow table separators and code backslashes stay literal',()=>{
 assert.deepEqual(splitTableRow('| `unfinished | second |'),['`unfinished','second']);
 assert.deepEqual(splitTableRow('| `ends\\` | second |'),['`ends\\`','second']);
});
test('new tables escape delimiters without double-escaping source and render multiline cells safely',()=>{
 const table=createTableBlock({headers:['Header | part','Code'],rows:[[String.raw`a\|b and C:\\work`,'first\nsecond\n<script>bad</script>']]});
 const markdown=serializeTable(table),[reopened]=parseMarkdown(markdown);assert.equal(reopened.headers[0],String.raw`Header \| part`);assert.equal(reopened.rows[0][0],table.rows[0][0]);assert.equal(reopened.rows[0][1],'first<br>second<br><script>bad</script>');
 const html=renderMarkdown(markdown);assert.match(html,/Header \| part/);assert.match(html,/first<br>second<br>&lt;script&gt;/);assert.doesNotMatch(html,/<script|<img|<iframe/i);assert.equal(renderTableCell('`<br>`'),'<code>&lt;br&gt;</code>');
});
test('table rows without a pipe are padded without discarding later text',()=>{
 const [table,heading]=parseMarkdown('A | B\n--- | ---\nOnly first\n# After');assert.equal(table.type,'table');assert.deepEqual(table.rows,[['Only first']]);assert.equal(heading.type,'h1');assert.match(renderMarkdown(serializeTable(table)),/<td>Only first<\/td><td><\/td>/);
});
test('table mutations retain all other cells, operate independently and keep one column',()=>{
 const original=createTableBlock({headers:['A','B'],rows:[['one','two'],['three','four']],alignments:['left','right']});
 const inserted=insertTableColumn(insertTableRow(original,1),1);assert.deepEqual(inserted.headers,['A','','B']);assert.deepEqual(inserted.rows,[['one','','two'],['','',''],['three','','four']]);assert.deepEqual(inserted.alignments,['left','','right']);
 const updated=updateTableCell(inserted,1,1,'new | content');assert.equal(inserted.rows[1][1],'');assert.equal(updated.rows[1][1],'new | content');assert.deepEqual(removeTableColumn(removeTableRow(updated,1),1).rows,original.rows);assert.deepEqual(original.rows,[['one','two'],['three','four']]);
 assert.throws(()=>removeTableColumn(createTableBlock({headers:['Only'],rows:[]}),0),/at least one column/);assert.throws(()=>updateTableCell(original,8,0,'lost'),/existing table cell/);assert.throws(()=>insertTableRow(original,-1),/valid row/);
});
test('table keyboard navigation visits headers and rows, appends at the end and can leave backwards',()=>{
 const table=createTableBlock({headers:['A','B'],rows:[['one','two']]});
 assert.deepEqual(tableCellPosition(table,{row:-1,column:0},'Tab'),{row:-1,column:1,appendRow:false});
 assert.deepEqual(tableCellPosition(table,{row:-1,column:1},'Tab'),{row:0,column:0,appendRow:false});
 assert.deepEqual(tableCellPosition(table,{row:0,column:0},'Tab',{shift:true}),{row:-1,column:1,appendRow:false});
 assert.deepEqual(tableCellPosition(table,{row:-1,column:0},'Tab',{shift:true}),{leave:true});
 assert.deepEqual(tableCellPosition(table,{row:0,column:1},'Tab'),{row:1,column:0,appendRow:true});
 assert.deepEqual(tableCellPosition(table,{row:-1,column:1},'Enter'),{row:0,column:1,appendRow:false});
 assert.deepEqual(tableCellPosition(table,{row:0,column:0},'Enter'),{row:1,column:0,appendRow:true});
 assert.deepEqual(tableCellPosition(createTableBlock({rows:[]}),{row:-1,column:0},'Enter'),{row:0,column:0,appendRow:true});
});
test('toggle Markdown round trips nested containers, literal fences, empty lines and open state',()=>{
 const inner=serializeToggle(createToggleBlock({title:'Inner',text:'line\n:::literal\n::::',open:false}));
 const toggle=createToggleBlock({title:'A **thought**',text:'\n'+inner+'\n\n::: \n:::<script>\n',open:true});
 const source=serializeToggle(toggle),[reopened]=parseMarkdown(source);assert.equal(reopened.type,'toggle');assert.equal(reopened.title,toggle.title);assert.equal(reopened.text,toggle.text);assert.equal(reopened.open,true);assert.equal(serializeBlocks([reopened]),source);
 const html=renderMarkdown(source);assert.match(html,/<details class="markdown-toggle" open>/);assert.match(html,/<summary>A <strong>thought<\/strong><\/summary>/);assert.equal((html.match(/<details/g)||[]).length,2);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});
test('unclosed toggle source stays ordinary text without losing body content',()=>{
 const source=':::toggle [open] Incomplete\nkeep\n\n# Heading';const blocks=parseMarkdown(source);assert.equal(blocks[0].type,'paragraph');assert.equal(serializeBlocks(blocks),source);assert.doesNotMatch(renderMarkdown(source),/<details/);
});
test('safe renderer supports notes and never executes raw HTML or image references',()=>{
 const source='# Title\n- First\n- Second\n1. Ordered\n> Source\n> [!NOTE] Careful\n---\n![picture](https://example.com/pic.png)\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n[bad](javascript:alert(1))\n[encoded](jav&#x61;script:alert(1))\n[safe](https://example.com/a?q=%22%3E)';
 const html=renderMarkdown(source);assert.match(html,/<h1>Title<\/h1>/);assert.match(html,/<ul><li>First<\/li><li>Second<\/li><\/ul>/);assert.match(html,/<ol><li>Ordered<\/li><\/ol>/);assert.match(html,/<blockquote>Source<\/blockquote>/);assert.match(html,/class="markdown-callout"/);assert.match(html,/class="markdown-media-link" href="https:\/\/example.com\/pic.png"/);assert.match(html,/href="https:\/\/example.com\/a\?q=%22%3E"/);assert.doesNotMatch(html,/<img|<iframe|<script|href="javascript:|onerror="/i);
});
test('links reject unsafe protocols, controls and embedded credentials',()=>{
 for(const value of ['javascript:alert(1)','data:text/html,hi','file:///C:/private.txt','vbscript:bad','https://user:pass@example.com/','https://example.com/\nnext','//example.com'])assert.equal(safeMarkdownUrl(value),'');
 assert.equal(safeMarkdownUrl('https://example.com'),'https://example.com/');assert.equal(safeMarkdownUrl('mailto:hello@example.com'),'mailto:hello@example.com');assert.equal(safeMarkdownUrl('#an-idea'),'#an-idea');
});
test('inline code stays literal and ordinary links, emphasis and escaped text are safe',()=>{
 assert.equal(renderInline('`**literal** <script>`'),'<code>**literal** &lt;script&gt;</code>');assert.equal(renderInline(String.raw`\*literal\* and **strong**`),'*literal* and <strong>strong</strong>');assert.equal(renderInline('`` `inside` ``'),'<code>`inside`</code>');assert.match(renderInline('[a [label]](https://example.com/a_(b))'),/>a \[label\]<\/a>/);
});
test('interactive task indices match source-line indices, including lexical tasks inside code and nested toggles',()=>{
 const source='```md\n- [ ] literal code\n```\n- [x] Outside\n::::toggle [open] More\n- [ ] Inside\n```\n- [ ] literal nested code\n```\n:::toggle [closed] Nested\n- [ ] Deep\n:::\n::::\n- [ ] After';
 const html=renderMarkdown(source,{interactiveTasks:true});assert.match(html,/data-task-index="1" checked/);assert.match(html,/data-task-index="2"/);assert.match(html,/data-task-index="4"/);assert.match(html,/data-task-index="5"/);assert.doesNotMatch(html,/data-task-index="[03]"/);
});
test('AI source citations render only provided ids, escape labels, and stay literal in code',()=>{
 const citations=[{id:'item:1',title:'<img src=x> "Source"'}],source='Uses [[item:1]] and [[missing]].\n\n| Source |\n| --- |\n| **[[item:1]]** |\n\n:::toggle [open] Details\n[[item:1]]\n:::\n\n`[[item:1]]`\n```md\n[[item:1]]\n```';
 const html=renderMarkdown(source,{citations});assert.equal((html.match(/class="ai-citation"/g)||[]).length,3);assert.match(html,/data-id="item:1"/);assert.match(html,/title="&lt;img src=x&gt; &quot;Source&quot;"/);assert.match(html,/\[source unavailable\]/);assert.match(html,/<code>\[\[item:1\]\]<\/code>/);assert.match(html,/<code data-language="md">\[\[item:1\]\]<\/code>/);assert.doesNotMatch(html,/<img/);assert.equal(renderInline('[[item:1]]'),'[[item:1]]');assert.match(renderInline('[[missing]]',{citations:[]}),/\[source unavailable\]/);
});
test('slash catalogue finds table, toggle and media through aliases and multiword filters',()=>{
 for(const [query,type] of [['/grid','table'],['/collapsible','toggle'],['/checklist','todo'],['/attachment','file'],['/picture','image'],['/url','link'],['/heading 2','h2']])assert.equal(findBlockCommands(query)[0][0],type);assert.deepEqual(findBlockCommands('/nothing-exists'),[]);
});
test('inline DOM serialization preserves link labels, safe destinations and variable code fences',()=>{
 const text=value=>({nodeType:3,textContent:value}),element=(tagName,attrs,...childNodes)=>({nodeType:1,tagName,childNodes,getAttribute:name=>attrs[name]}),fragment=(...childNodes)=>({nodeType:11,childNodes});
 assert.equal(serializeInlineFragment(fragment(element('A',{href:'https://example.com/'},text('A [reference]')))),'[A \\[reference\\]](<https://example.com/>)');
 assert.equal(serializeInlineFragment(fragment(element('A',{href:'javascript:bad'},text('Text only')))),'Text only');
 const image=element('A',{href:'https://example.com/pic.png',class:'markdown-media-link'},element('SPAN',{},text('Image · ')),text('A picture'));
 assert.equal(serializeInlineFragment(fragment(image)),'![A picture](<https://example.com/pic.png>)');
 const source=serializeInlineFragment(fragment(element('CODE',{},text('a ` b'))));assert.equal(renderInline(source),'<code>a ` b</code>');
});
