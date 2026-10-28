import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdown,serializeBlocks,findBlockCommands,serializeInlineFragment,htmlToMarkdown,matchBlockShortcut,matchInlineShortcut,matchWikiShortcut,BLOCK_COMMANDS} from '../extension/lib/block-editor.js';
import {renderMarkdown,renderInline} from '../extension/lib/markdown.js';
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

const el=(tagName,attrs={},...childNodes)=>({nodeType:1,tagName,childNodes,getAttribute:name=>attrs[name]??null});

test('typed text is escaped wherever it would otherwise read back as formatting (B3)',()=>{
 const cases=[['2 * 3','2 * 3'],['*x*','\\*x\\*'],['a_b and _c','a_b and \\_c'],['x__y','x\\_\\_y'],['[x]','\\[x]'],['`c`','\\`c\\`'],['~~s~~ ~a','\\~\\~s\\~\\~ ~a'],['<b>','\\<b>'],['a < b','a < b'],['a\\b','a\\b'],['\\*','\\\\\\*']];
 for(const [typed,markdown] of cases){
  assert.equal(serializeInlineFragment(fragment(text(typed))),markdown,typed);
  assert.equal(renderInline(markdown).replace(/&lt;/g,'<').replace(/&gt;/g,'>'),typed,`${typed} renders back as typed`);
 }
 assert.equal(serializeInlineFragment(fragment(text('see https://a.com/a_b*c*. ok'))),'see https://a.com/a_b*c\\*. ok','bare URLs stay verbatim so they keep linking');
 assert.equal(serializeInlineFragment(fragment(text('a b​c'))),'a bc','no-break spaces and caret helpers are normalized');
});

test('inline serialization keeps links, chips and adjacent marks readable',()=>{
 assert.equal(serializeInlineFragment(fragment(el('A',{class:'note-link','data-target':'Alpha','data-label':'Lbl'},text('Lbl')),text(' '),el('SPAN',{class:'note-link is-missing','data-target':'Gone'},text('Gone')))),'[[Alpha|Lbl]] [[Gone]]');
 assert.equal(serializeInlineFragment(fragment(el('BUTTON',{class:'ai-citation','data-id':'item:1'},text('Src')))),'[[item:1]]');
 assert.equal(serializeInlineFragment(fragment(el('STRONG',{},text('a')),el('STRONG',{},text('b')))),'**ab**','adjacent bold runs merge');
 assert.equal(serializeInlineFragment(fragment(el('EM',{},text('a')),el('STRONG',{},text('b')))),'_a_**b**','italic touching bold switches to underscores');
 assert.equal(renderInline('_a_**b**'),'<em>a</em><strong>b</strong>');
 assert.equal(serializeInlineFragment(fragment(el('STRONG',{},el('EM',{},text('x'))))),'***x***');
 assert.equal(serializeInlineFragment(fragment(el('A',{href:'https://a.com/','data-autolink':'bare'},text('https://a.com')))),'https://a.com');
 assert.equal(serializeInlineFragment(fragment(el('B',{style:'font-weight:normal'},text('plain')))),'plain','Google Docs wrapper bold is not bold');
 assert.equal(serializeInlineFragment(fragment(el('SPAN',{style:'font-weight:700;font-style:italic'},text('both')))),'***both***');
});

test('block shortcuts typed at the start of a block',()=>{
 const expected={'# ':{type:'h1'},'## ':{type:'h2'},'### ':{type:'h3'},'- ':{type:'bullet'},'* ':{type:'bullet'},'+ ':{type:'bullet'},'1. ':{type:'number',ordinal:1},'12) ':{type:'number',ordinal:12},'[] ':{type:'todo',checked:false},'[ ] ':{type:'todo',checked:false},'[x] ':{type:'todo',checked:true},'[X] ':{type:'todo',checked:true},'> ':{type:'quote'},'>! ':{type:'callout',kind:'note'},'```':{type:'code'},'---':{type:'divider'},'# ':{type:'h1'}};
 for(const [typed,hit] of Object.entries(expected))assert.deepEqual(matchBlockShortcut(typed),hit,typed);
 for(const typed of ['#### ','-','# x','1.','text - ','[]'])assert.equal(matchBlockShortcut(typed),null,typed);
});

test('inline shortcuts convert on the closing marker and respect escapes and word boundaries',()=>{
 assert.deepEqual(matchInlineShortcut('a **b**'),{mark:'bold',start:2,end:7,text:'b'});
 assert.deepEqual(matchInlineShortcut('a __b c__'),{mark:'bold',start:2,end:9,text:'b c'});
 assert.deepEqual(matchInlineShortcut('a *i*'),{mark:'italic',start:2,end:5,text:'i'});
 assert.deepEqual(matchInlineShortcut('a _i_'),{mark:'italic',start:2,end:5,text:'i'});
 assert.deepEqual(matchInlineShortcut('a `c d`'),{mark:'code',start:2,end:7,text:'c d'});
 assert.deepEqual(matchInlineShortcut('a ~~s~~'),{mark:'strike',start:2,end:7,text:'s'});
 assert.deepEqual(matchInlineShortcut('see [x](https://a.com)'),{mark:'link',start:4,end:22,text:'x',href:'https://a.com/'});
 for(const typed of ['a ** b**','a \\**b**','snake__b__','word_i_','a ~s~','see [x](javascript:alert(1))','![x](https://a.com)','a ***b***','**a** *','plain'])assert.equal(matchInlineShortcut(typed),null,typed);
});

test('slash catalogue ranks exact and prefix matches first and accepts a custom catalogue',()=>{
 assert.deepEqual(findBlockCommands('/h').slice(0,3).map(c=>c[0]),['h1','h2','h3']);
 assert.equal(findBlockCommands('/quote')[0][0],'quote');
 assert.equal(findBlockCommands('/hr')[0][0],'divider');
 assert.equal(findBlockCommands('').length,BLOCK_COMMANDS.length);
 assert.deepEqual(findBlockCommands('wiki',[...BLOCK_COMMANDS,['note-link','Link to note','',''] ]).map(c=>c[0]),['note-link']);
 for(const [id,label] of BLOCK_COMMANDS)assert.ok(id&&label,'every command has an id and a label');
});

test('htmlToMarkdown converts pasted rich text into note Markdown and drops unsafe markup',()=>{
 assert.equal(htmlToMarkdown('<h1>One</h1><h4>Four</h4><p>Para <b>b</b> <i>i</i> <s>s</s> <code>c`d</code></p>'),'# One\n### Four\nPara **b** *i* ~~s~~ ``c`d``');
 assert.equal(htmlToMarkdown('<p><a href="https://a.com/x">A</a> <a href="javascript:alert(1)">bad</a> <img src="https://a.com/p.png" alt="Pic"> <img src="data:x" alt="inline"></p>'),'[A](<https://a.com/x>) bad ![Pic](<https://a.com/p.png>) inline');
 assert.equal(htmlToMarkdown('<ul><li>one<ul><li>nested</li></ul></li><li><input type="checkbox" checked> done</li><li><p><input type="checkbox"> todo</p></li></ul><ol start="3"><li>three</li><li>four</li></ol>'),'- one\n  - nested\n- [x] done\n- [ ] todo\n3. three\n4. four');
 assert.equal(htmlToMarkdown('<blockquote><p>q1</p><p>q2</p></blockquote><pre><code class="language-js">const x = 1;\n</code></pre><hr><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table>'),'> q1\n> q2\n```js\nconst x = 1;\n```\n---\n| A | B |\n| --- | --- |\n| 1 | 2\\|3 |');
 assert.equal(htmlToMarkdown('<details open><summary>Sum</summary><p>Body <strong>x</strong></p></details>'),':::toggle [open] Sum\nBody **x**\n:::');
 assert.equal(htmlToMarkdown('<style>p{}</style><script>alert(1)</script><p>keep &amp; &lt;tag&gt; &#x41; &unknown;</p><iframe src="x">no</iframe>'),'keep & \\<tag> A &unknown;');
 assert.equal(htmlToMarkdown('<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">Bold</span> <span style="font-style:italic">it</span> <span style="text-decoration:line-through">gone</span></p></b>'),'**Bold** *it* ~~gone~~');
 assert.equal(htmlToMarkdown('<html><body><!--StartFragment--><p>only *this*</p><!--EndFragment--></body></html>'),'only \\*this\\*');
 assert.equal(htmlToMarkdown('<p>a<br>b</p><div>c</div><div>d</div>'),'a\\\nb\nc\nd');
 assert.equal(htmlToMarkdown('<div class="markdown-alert markdown-alert-warning"><p class="markdown-alert-title">Warning</p><p>Careful</p></div>'),'> [!WARNING]\n> Careful');
 assert.equal(htmlToMarkdown('plain <em>text</em> only'),'plain *text* only');
 assert.equal(htmlToMarkdown('<p>Per <button type="button" class="ai-citation" data-id="item_1" title="Src">Src</button> and <button>Copy</button><button class="ai-citation" data-id="a]]b">X</button>.</p>'),'Per [[item_1]] and .','AI source chips copied from an answer keep their id; other buttons drop');
 assert.equal(htmlToMarkdown('<p> </p>'),'');
});

test('Markdown copied out of the editor as HTML pastes back as the same note',()=>{
 const source='# T\nPara with **b**, *i*, `c` and [l](<https://a.com/>).\n- a\n  - b\n- [x] done\n1. one\n> q\n> [!TIP]\n> tip\n```js\nx\n```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n---\n:::toggle [closed] More\nhidden\n:::';
 assert.equal(htmlToMarkdown(renderMarkdown(source,{interactiveTasks:true})),source);
});

test('a fully typed or pasted wiki link stays a link; other brackets stay escaped',()=>{
 const resolve=title=>({alpha:{id:'item_1',title:'Alpha',type:'note'},item_2:{id:'item_2',title:'Second',type:'note'}})[String(title).toLowerCase()]||null;
 const cases=[['See [[Alpha]] and [[item_2|the second]].','See [[Alpha]] and [[item_2|the second]].'],['[[ ]] [[a] [x]','\\[\\[ ]] \\[\\[a] \\[x]'],['\\[[Alpha]]','\\\\[[Alpha]]'],['[[[Alpha]]]','\\[[[Alpha]]]'],['a_[[Alpha]]_b','a\\_[[Alpha]]\\_b']];
 for(const [typed,markdown] of cases){
  assert.equal(serializeInlineFragment(fragment(text(typed))),markdown,typed);
  assert.equal(renderInline(markdown),typed.replace(/&/g,'&amp;'),`${typed} renders back as typed without a resolver`);
 }
 assert.equal(serializeInlineFragment(fragment(text('https://a.com/[[x]] [[y]]'))),'https://a.com/[[x]] [[y]]','a bare URL keeps its brackets and the link after it stays a link');
 assert.match(renderInline('\\\\[[Alpha]]',{resolveLink:resolve}),/^\\<a class="note-link" href="#" data-id="item_1"/,'a typed backslash before a link stays text');
 assert.match(renderInline('See [[Alpha]] and [[item_2|the second]].',{resolveLink:resolve}),/data-id="item_1"[^>]*>Alpha<\/a> and <a class="note-link" href="#" data-id="item_2"[^>]*data-label="the second"[^>]*>the second<\/a>/);
 // The chips the editor draws for those links serialize back to the same source.
 assert.equal(serializeInlineFragment(fragment(text('See '),el('A',{class:'note-link','data-target':'Alpha'},text('Alpha')),text(' and '),el('A',{class:'note-link','data-target':'item_2','data-label':'the second'},text('the second')),text('.'))),'See [[Alpha]] and [[item_2|the second]].');
 // Link labels never parse wiki links, so brackets (and chips) inside a label stay literal text.
 assert.equal(serializeInlineFragment(fragment(el('A',{href:'https://a.com/'},text('[[Alpha]]')))),'[\\[\\[Alpha\\]\\]](<https://a.com/>)');
 assert.equal(renderInline('[\\[\\[Alpha\\]\\]](<https://a.com/>)',{resolveLink:resolve}),'<a class="markdown-link" href="https://a.com/" target="_blank" rel="noopener noreferrer">[[Alpha]]</a>');
 assert.equal(serializeInlineFragment(fragment(el('A',{href:'https://a.com/'},text('See '),el('A',{class:'note-link','data-target':'Alpha'},text('Alpha'))))),'[See Alpha](<https://a.com/>)');
 assert.equal(serializeInlineFragment(fragment(el('IMG',{src:'https://a.com/p.png',alt:'[[Alpha]]'}))),'![\\[\\[Alpha\\]\\]](<https://a.com/p.png>)');
 assert.equal(htmlToMarkdown('<p>Pasted [[Alpha]] and [[id_9|Nine]] <a href="https://a.com/">[[not a link]]</a></p>'),'Pasted [[Alpha]] and [[id_9|Nine]] [\\[\\[not a link\\]\\]](<https://a.com/>)');
});

test('typed wiki links render no markup from titles, labels or targets',()=>{
 const hostile='<img src=x onerror=alert(1)> & "q"';
 const markdown=serializeInlineFragment(fragment(text(`[[${hostile}]] [[javascript:alert(1)]] [[x|${hostile}]]`)));
 assert.equal(markdown,`[[${hostile}]] [[javascript:alert(1)]] [[x|${hostile}]]`);
 for(const resolveLink of [()=>null,()=>({id:'"><script>alert(1)</script>',title:hostile,type:'note" onclick="x'})]){
  const html=renderInline(markdown,{resolveLink});
  for(const [,tag,attrs] of html.matchAll(/<\/?(\w+)([^>]*)>/g)){
   assert.ok(['a','span'].includes(tag),tag);
   assert.equal(attrs.replace(/ (?:class|href|data-id|data-type|data-target|data-label|title)="[^"<>]*"/g,''),'','only known attributes, all quoted and escaped');
  }
  assert.doesNotMatch(html,/href="(?!#")/,'chips never carry a real href');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;'));
 }
});

test('matchWikiShortcut fires on the "]]" that closes a wiki link',()=>{
 assert.deepEqual(matchWikiShortcut('See [[Alpha]]'),{start:4,end:13,target:'Alpha',label:''});
 assert.deepEqual(matchWikiShortcut('[[ item_2 | the second ]]'),{start:0,end:25,target:'item_2',label:'the second'});
 assert.deepEqual(matchWikiShortcut('[[[a]]'),{start:1,end:6,target:'a',label:''});
 assert.deepEqual(matchWikiShortcut('x'.repeat(5000)+'[[a]]'),{start:5000,end:5005,target:'a',label:''});
 for(const typed of ['[[Alpha]','[[Alpha]] ','[[ ]]','[[a\nb]]','[[a[b]]','[Alpha]]','[[|x]]',`[[${'a'.repeat(201)}]]`,''])assert.equal(matchWikiShortcut(typed),null,JSON.stringify(typed));
});
