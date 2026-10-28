import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown,renderInline,inlineText,plainText,trimAutolink,CALLOUT_KINDS} from '../extension/lib/markdown.js';

const resolve=target=>({Alpha:{id:'n1',title:'Alpha',type:'note'},n2:{id:'n2',title:'Beta',type:'bookmark'}})[target]||null;

test('bare http(s) URLs autolink without trailing punctuation and only at a word start',()=>{
 const html=renderInline('see https://github.com/x/y. end');
 assert.equal(html,'see <a class="markdown-link" data-autolink="bare" href="https://github.com/x/y" target="_blank" rel="noopener noreferrer">https://github.com/x/y</a>. end');
 assert.match(renderInline('(https://a.com/b_(c))'),/href="https:\/\/a.com\/b_\(c\)"[^>]*>https:\/\/a.com\/b_\(c\)<\/a>\)$/,'balanced parentheses stay, the unbalanced one does not');
 for(const literal of ['xhttps://a.com','https://user:p@a.com','http://','ftp://a.com','javascript:alert(1)'])assert.equal(renderInline(literal),literal.replace(/&/g,'&amp;'));
 assert.equal(renderInline('`https://a.com`'),'<code>https://a.com</code>');
 assert.equal((renderInline('[https://a.com](https://b.com)').match(/<a /g)||[]).length,1,'no autolink inside a link label');
 assert.deepEqual([trimAutolink('https://a.com/x).'),trimAutolink('https://a.com/(x)'),trimAutolink('https://a.com/x]'),trimAutolink('https://a.com/a_b_')],['https://a.com/x','https://a.com/(x)','https://a.com/x','https://a.com/a_b']);
 assert.match(renderMarkdown('- https://github.com/a/b\n- https://github.com/c/d'),/<li><a [^>]*href="https:\/\/github.com\/a\/b"/);
});

test('emphasis follows CommonMark flanking rules: snake_case stays literal, nesting reads back',()=>{
 assert.equal(renderInline('my_var_name _em_ __init__'),'my_var_name <em>em</em> <strong>init</strong>');
 assert.equal(renderInline('snake_case_name and _x_y_'),'snake_case_name and <em>x_y</em>');
 assert.equal(renderInline('**a *b***'),'<strong>a <em>b</em></strong>');
 assert.equal(renderInline('*a **b***'),'<em>a <strong>b</strong></em>');
 assert.equal(renderInline('***x***'),'<em><strong>x</strong></em>');
 assert.equal(renderInline('2 * 3 * 4'),'2 * 3 * 4');
 assert.equal(renderInline('~one~ ~~two~~'),'~one~ <del>two</del>');
 assert.equal(renderInline('\\*not\\* \\_em\\_'),'*not* _em_');
});

test('hard breaks: a trailing backslash joins the next line into the same block',()=>{
 assert.equal(renderMarkdown('a\\\nb'),'<p>a<br>b</p>');
 assert.equal(renderMarkdown('- item\\\n  more'),'<ul><li>item<br>more</li></ul>');
 assert.equal(renderInline('a\\'),'a\\','a final backslash stays literal');
 assert.equal(renderMarkdown('line\\\n- not a list'),'<p>line\\</p><ul><li>not a list</li></ul>','a following list item still starts a block (the backslash is then literal, as in CommonMark)');
});

test('nested lists render as nested ul/ol, tasks keep their children',()=>{
 assert.equal(renderMarkdown('- a\n  - b\n    - c\n- d'),'<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
 assert.equal(renderMarkdown('1. one\n   - sub\n2. two'),'<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>');
 assert.match(renderMarkdown('3. three\n   1. inner\n   2. inner two\n4. four'),/^<ol start="3"><li>three<ol><li>inner<\/li><li>inner two<\/li><\/ol><\/li><li>four<\/li><\/ol>$/);
 const tasks=renderMarkdown('- [ ] t\n  - [x] u\n  - v',{interactiveTasks:true});
 assert.match(tasks,/^<div class="task-line"><input type="checkbox" data-task-index="0" aria-label="t"><span>t<\/span><\/div><div class="task-children"><div class="task-line done"><input type="checkbox" data-task-index="1" checked aria-label="u"><span>u<\/span><\/div><ul><li>v<\/li><\/ul><\/div>$/);
 assert.match(renderMarkdown('- [ ] **Bold** [link](https://a.com) task',{interactiveTasks:true}),/aria-label="Bold link task"/,'checkbox names are plain text');
});

test('GitHub alerts render as markdown-callout with data-kind; the legacy one-line note still works',()=>{
 const tip=renderMarkdown('> [!TIP]\n> body **b**\n> more');
 assert.match(tip,/^<div class="markdown-callout" data-kind="tip" role="note"><p class="markdown-callout-title"><svg class="markdown-callout-icon"[^>]*aria-hidden="true"[^>]*>.*<\/svg><span>Tip<\/span><\/p><div class="markdown-callout-body">body <strong>b<\/strong><br>more<\/div><\/div>$/);
 for(const kind of Object.keys(CALLOUT_KINDS))assert.match(renderMarkdown(`> [!${kind.toUpperCase()}]\n> x`),new RegExp(`data-kind="${kind}"[\\s\\S]*<span>${CALLOUT_KINDS[kind].label}</span>`));
 assert.match(renderMarkdown('> [!warning]\n> w'),/data-kind="warning"/,'markers are case-insensitive');
 assert.match(renderMarkdown('> [!NOTE] legacy text'),/data-kind="note"[\s\S]*markdown-callout-body">legacy text</);
 assert.equal(renderMarkdown('> [!FOO] text'),'<blockquote>[!FOO] text</blockquote>');
 assert.equal(renderMarkdown('> q1\n> q2\n>\n> q3'),'<blockquote>q1<br>q2<br><br>q3</blockquote>','consecutive quote lines are one quote');
 assert.match(renderMarkdown('> Source\n> [!NOTE] Careful'),/^<blockquote>Source<\/blockquote><div class="markdown-callout" data-kind="note"/,'an alert line starts a new block');
});

test('[[wiki links]] resolve to note-link chips with linkClass; unresolved ones are marked missing',()=>{
 assert.equal(renderInline('[[Alpha]]',{resolveLink:resolve,linkClass:'chip x'}),'<a class="note-link chip x" href="#" data-id="n1" data-type="note" data-target="Alpha" title="Alpha">Alpha</a>');
 assert.equal(renderInline('[[n2]]',{resolveLink:resolve,linkClass:link=>'is-'+link.type}),'<a class="note-link is-bookmark" href="#" data-id="n2" data-type="bookmark" data-target="n2" title="Beta">Beta</a>','a bare id shows the title');
 assert.match(renderInline('[[n2|Shown]]',{resolveLink:resolve}),/data-target="n2" data-label="Shown" title="Beta">Shown<\/a>$/);
 assert.equal(renderInline('[[Alpha]]',{resolveLink:()=>{throw new Error('boom');}}),'<span class="note-link is-missing" data-target="Alpha" title="No matching note">Alpha</span>');
 assert.equal(renderInline('[[<b>|<i>]]',{resolveLink:()=>null}),'<span class="note-link is-missing" data-target="&lt;b&gt;" data-label="&lt;i&gt;" title="No matching note">&lt;i&gt;</span>');
 const escaped=renderInline('\\[[Alpha]] `[[Alpha]]` [x [[Alpha]]](https://a.com)',{resolveLink:resolve});
 assert.doesNotMatch(escaped,/note-link/,'escaped, code and link-label wiki links stay literal');
 assert.equal(renderInline('[[Alpha]]'),'[[Alpha]]','no resolver and no citations: literal text');
 assert.match(renderMarkdown('| [[Alpha]] |\n| --- |\n| [[Gone]] |',{resolveLink:resolve}),/<th scope="col"><a class="note-link"[\s\S]*<td><span class="note-link is-missing"/);
});

test('citations keep priority for listed ids; other targets fall through to resolveLink',()=>{
 const html=renderInline('[[item:1]] [[n2]] [[zzz]] [[Alpha|Lbl]]',{citations:[{id:'item:1',title:'Src'}],resolveLink:resolve});
 assert.match(html,/^<button type="button" class="ai-citation" data-ai-action="source" data-id="item:1" title="Src">Src<\/button> <a class="note-link"[^>]*data-id="n2"/);
 assert.match(html,/<span class="note-link is-missing" data-target="zzz"/);
 assert.doesNotMatch(html,/source unavailable/);
 assert.match(renderInline('[[zzz]]',{citations:[]}),/\[source unavailable\]/,'without a resolver an unknown id is an unavailable source');
 assert.equal((renderInline('[[x]]',{citations:[{id:'x',title:'A very long source title that will be shortened for the chip'}]}).match(/>([^<]*)<\/button>/)||[])[1].length,36);
});

test('images never load: they render as media links; raw HTML stays text',()=>{
 assert.equal(renderMarkdown('![alt](https://x.com/a.png)'),'<p><a class="markdown-media-link" href="https://x.com/a.png" target="_blank" rel="noopener noreferrer"><span>Image · </span>alt</a></p>');
 const html=renderMarkdown('<img src=x onerror=alert(1)> ![a](javascript:alert(1)) https://x.com/"onmouseover=alert(1)');
 assert.doesNotMatch(html,/<img|onerror="|href="javascript|onmouseover="/);
});

test('compact rendering closes toggles, flattens headings and caps blocks',()=>{
 assert.equal(renderMarkdown('# H\n:::toggle [open] T\nx\n:::',{compact:true}),'<h3>H</h3><details class="markdown-toggle"><summary>T</summary><div><p>x</p></div></details>');
 assert.equal((renderMarkdown(Array.from({length:20},(_,i)=>`line ${i}`).join('\n'),{compact:true}).match(/<p>/g)||[]).length,12);
});

test('inlineText and plainText give readable text for excerpts and labels',()=>{
 assert.equal(inlineText('**b** [l](https://a.com) [[T|Lbl]] [[U]] `c` a\\\nb'),'b l Lbl U c a\nb');
 assert.equal(inlineText('&lt; <b>'),'&lt; <b>','entities and tags are literal text');
 assert.equal(plainText('# T\n- [ ] x\n| a | b |\n| - | - |\n| 1 | 2 |\n:::toggle [open] Tt\nbody\n:::\n---\n```\ncode\n```'),'T\nx\na b\n1 2\nTt\nbody\n\ncode');
});
