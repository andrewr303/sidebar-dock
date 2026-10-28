// Block editor for note Markdown (SPEC §12.2).
//
// mountBlockEditor(textarea, options) mounts the editor where the <textarea name="content"> was and moves that
// textarea inside the editor root. The textarea stays the source of truth: every edit writes the serialized
// Markdown back to it, dispatches a bubbling "input" event on it and calls onChange(markdown). Only Markdown is
// stored; blocks are a view of it and untouched blocks re-serialize byte for byte.
//
// options
//  onChange(markdown)                      every edit in every mode (not setMarkdown without emit)
//  onAskAi({ text, markdown })             "Ask AI" in the selection toolbar and the slash menu (omit to hide both);
//                                          the payload also carries the older names { selection, draft }
//  placeholder                             shown while the note is empty ('Write, or press / for blocks')
//  searchLinks(query) -> Promise<[{ id, title, type, subtitle }]>   enables the [[ link picker, which inserts [[Title]]
//  resolveLink(title) -> { id, title, type } | null                  renders [[Title]] / [[id|Label]] as link chips
//  onOpenLink(id)                          a resolved link chip was clicked (blocks and preview)
//  onSelectionChange({ text, marks, block })  marks: Set of 'bold'|'italic'|'strike'|'code'|'link'; block: its type
//  mode = 'blocks'|'markdown'|'preview', showModeSwitch = true, compact = false (side panel sizing)
//
// returns
//  root                                    the .block-editor element (it contains the textarea)
//  getMarkdown(), setMarkdown(md, { emit = false })    emit records an undo step and fires onChange
//  getSelection() -> { text, start, end }  text is the selected text; start/end are offsets into getMarkdown()
//  command(type, args)                     'paragraph'|'h1'|'h2'|'h3'|'bullet'|'number'|'todo'|'quote'|'code'|'divider'|
//                                          'table'|'toggle'|'callout'|'link'|'image'|'file'. Text types turn the current
//                                          (or selected) blocks into that type, or back into text when they already are;
//                                          divider and table insert a block. args: { kind } callout, { language } code,
//                                          { url, label } link/image/file (without url the link form opens)
//  format(mark)                            'bold'|'italic'|'strike'|'code'|'link' toggles on the text selection
//  insertMarkdown(md, { at })              'cursor' (default) | 'end' | 'replace-selection'; Markdown becomes blocks
//  undo(), redo(), focus({ at: 'start'|'end' }), setMode(mode), getMode(), destroy()
//
// Keyboard: Enter splits a block, Shift+Enter adds a line break, Backspace at the start turns a block into text and
// then merges it upward, Delete at the end merges the next block, arrow keys cross block edges, Tab and Shift+Tab
// nest list items, Alt+Shift+Up/Down move blocks, Escape selects the current block, Shift+Click or Shift+Up/Down at an
// edge select a range of blocks (Copy gives Markdown, Cut, Delete), Mod+/ (or the Menu key, Shift+F10) opens the block
// menu (turn into, duplicate, move, delete), Mod+D duplicates, Mod+Z, Mod+Shift+Z and Mod+Y use the editor's own
// history, Mod+B/I/E/K and Mod+Shift+X format. "# ", "## ", "### ", "- ", "* ", "1. ", "[] ", "[ ] ", "> ", ">! ", "```"
// and "---" at the start of a block change its type; **bold**, *italic*, `code`, ~~strike~~ and [label](url) convert
// when closed; "/" opens the insert menu and "[[" the link picker. Paste and drop accept plain text, Markdown and HTML.
//
// Also exported (pure, Node-importable): BLOCK_COMMANDS, findBlockCommands, parseMarkdown, serializeBlocks,
// serializeInlineFragment, matchBlockShortcut, matchInlineShortcut, htmlToMarkdown.
// Styles: styles/editor.css. Render Markdown elsewhere inside an element with class "markdown-body".
import {
 escapeHtml as esc, safeMarkdownUrl, renderInline, renderTableCell, renderMarkdown, inlineText, trimAutolink, CALLOUT_KINDS,
 parseNoteBlocks, serializeNoteBlocks, serializeBlockParts, listNumbers, createTableBlock, createToggleBlock,
 tableWidth, insertTableRow, removeTableRow, insertTableColumn, removeTableColumn, tableCellPosition
} from './markdown.js';
import {toggleTask} from './notes.js';

const uid=()=>globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2);
const ICONS={
 text:'<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
 h1:'<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>',
 h2:'<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>',
 h3:'<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>',
 bullet:'<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
 number:'<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
 todo:'<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
 toggle:'<path d="m9 18 6-6-6-6"/>',
 quote:'<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
 callout:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/>',
 table:'<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
 link:'<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
 image:'<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
 file:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
 code:'<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
 divider:'<path d="M5 12h14"/>',
 note:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
 ai:'<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
 grip:'<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
 plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
 bold:'<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
 italic:'<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
 strike:'<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
 inlineCode:'<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
 trash:'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
 clipboard:'<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
 copy:'<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
 up:'<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
 down:'<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
 bookmark:'<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'
};
const icon=(name,size=16)=>`<svg class="be-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]||ICONS.text}</svg>`;
const calloutIcon=kind=>`<svg class="be-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${(CALLOUT_KINDS[kind]||CALLOUT_KINDS.note).icon}</svg>`;

// [id, label, description, icon]. Ids and aliases are a tested contract (slash menu, command()).
export const BLOCK_COMMANDS=[
 ['paragraph','Text','Plain text.','text'],
 ['h1','Heading 1','Large section heading.','h1'],
 ['h2','Heading 2','Medium section heading.','h2'],
 ['h3','Heading 3','Small section heading.','h3'],
 ['bullet','Bulleted list','A simple list.','bullet'],
 ['number','Numbered list','A list with numbers.','number'],
 ['todo','To-do list','Track tasks with checkboxes.','todo'],
 ['toggle','Toggle list','Hide details under a title.','toggle'],
 ['quote','Quote','Capture a quotation.','quote'],
 ['callout','Callout','Make a note stand out.','callout'],
 ['table','Table','Rows and columns.','table'],
 ['link','Link','Add a web link.','link'],
 ['image','Image link','Link to an image without loading it.','image'],
 ['file','File link','Link to a file by its web address.','file'],
 ['code','Code','A code block.','code'],
 ['divider','Divider','Separate sections.','divider']
];
const SLASH_EXTRAS=[['note-link','Link to note','Link another note or saved item.','note'],['ai','Ask AI','Write or edit with AI.','ai']];
const aliases={paragraph:['text','plain'],h1:['heading1','title'],h2:['heading2','subtitle'],h3:['heading3'],bullet:['ul','unordered','bullets'],number:['ol','ordered','numbered'],todo:['task','tasks','checklist','checkbox'],toggle:['collapse','collapsible','details','fold'],table:['grid','rows','columns','spreadsheet'],link:['url','bookmark','reference'],image:['picture','photo','media'],file:['attachment','document','pdf'],code:['fence','snippet'],divider:['hr','separator','line'],'note-link':['wiki','mention','page','backlink'],ai:['assistant','write','generate']};
const GROUPS=[['Basic blocks',['paragraph','h1','h2','h3']],['Lists',['bullet','number','todo','toggle']],['Media and links',['link','note-link','image','file']],['Advanced',['quote','callout','code','table','divider']],['AI',['ai']]];
const SHORTCUT_HINTS={h1:'#',h2:'##',h3:'###',bullet:'-',number:'1.',todo:'[]',quote:'>',callout:'>!',code:'```',divider:'---'};
const normalize=value=>String(value).toLowerCase().replace(/[\s_\-/]+/g,'');
// All terms must match an id, label or alias; exact and prefix matches rank first, then catalogue order.
export function findBlockCommands(query='',catalog=BLOCK_COMMANDS){
 const terms=String(query).replace(/^\//,'').trim().split(/\s+/).map(normalize).filter(Boolean);
 const scored=[];
 catalog.forEach((command,order)=>{
  const names=[command[0],command[1],...(aliases[command[0]]||[])].map(normalize);
  if(!terms.every(q=>names.some(name=>name.includes(q))))return;
  const score=terms.reduce((sum,q)=>sum+Math.max(...names.map(name=>name===q?3:name.startsWith(q)?2:name.includes(q)?1:0)),0);
  scored.push({command,score,order});
 });
 return scored.sort((a,b)=>b.score-a.score||a.order-b.order).map(entry=>entry.command);
}
export const parseMarkdown=parseNoteBlocks;
export const serializeBlocks=serializeNoteBlocks;

// DOM to inline Markdown. Works on real nodes and on plain { nodeType, tagName, childNodes, getAttribute? } objects.
// Literal text is escaped wherever it could otherwise read back as formatting, so edits never change meaning.
const ZWSP=/\u200b/g,PUNCT=/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/,WORD=/[\p{L}\p{N}]/u,SPACE=/\s/u;
const MARK_TAGS={STRONG:'bold',B:'bold',EM:'italic',I:'italic',S:'strike',DEL:'strike',STRIKE:'strike',CODE:'code'};
const MARKERS={bold:'**',italic:'*',strike:'~~'};
const attr=(node,name)=>node.getAttribute?.(name)??null;
const tagOf=node=>String(node.tagName||'').toUpperCase();
const classesOf=node=>String(attr(node,'class')||'').split(/\s+/);
function nodeMark(node){
 if(node.nodeType!==1)return null;const tag=tagOf(node);
 if(tag==='B'&&/font-weight\s*:\s*(?:normal|[1-5]00)\b/i.test(attr(node,'style')||''))return null;
 return MARK_TAGS[tag]||null;
}
function rawText(node){
 if(node.nodeType===3)return String(node.textContent??'').replace(ZWSP,'').replace(/\u00a0/g,' ');
 if(node.nodeType===1&&tagOf(node)==='BR')return '\n';
 return [...(node.childNodes||[])].map(rawText).join('');
}
function escapeSpan(text,out=''){
 for(let i=0;i<text.length;i++){
  const c=text[i],prev=text[i-1],next=text[i+1],edge=prev===undefined||next===undefined;
  if(c==='\\')out+=next===undefined||next==='\n'||PUNCT.test(next)?'\\\\':'\\';
  else if(c==='`'||c==='[')out+='\\'+c;
  else if(c==='*')out+=!edge&&SPACE.test(prev)&&SPACE.test(next)?'*':'\\*';
  else if(c==='_')out+=!edge&&((WORD.test(prev)&&WORD.test(next))||(SPACE.test(prev)&&SPACE.test(next)))?'_':'\\_';
  else if(c==='~')out+=prev==='~'||next==='~'||edge?'\\~':'~';
  else if(c==='<')out+=/[A-Za-z/!?]/.test(next||'')?'\\<':'<';
  else out+=c;
 }
 return out;
}
// Bare URLs are kept verbatim so they keep reading back as links.
function escapeText(value){
 const text=String(value??'').replace(ZWSP,'').replace(/\u00a0/g,' ');let out='',last=0;
 for(const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)){
  if(m.index>0&&WORD.test(text[m.index-1]))continue;
  const url=trimAutolink(m[0]);if(!/^https?:\/\/./i.test(url))continue;
  out+=escapeSpan(text.slice(last,m.index))+url;last=m.index+url.length;
 }
 return out+escapeSpan(text.slice(last));
}
function emphasize(text,marker){const leading=text.match(/^\s*/)[0],trailing=text.slice(leading.length).match(/\s*$/)[0],content=text.slice(leading.length,text.length-trailing.length);return content?leading+marker+content+marker+trailing:text;}
function codeSpan(text){if(!text)return '';const runs=text.match(/`+/g)||[],fence='`'.repeat(Math.max(0,...runs.map(s=>s.length))+1),padding=text.startsWith('`')||text.endsWith('`')||(/^ .* $/.test(text)&&text.trim())?' ':'';return fence+padding+text+padding+fence;}
const escapeLabel=label=>{let out='';for(let i=0;i<label.length;i++){if(label[i]===']'&&!escapedBefore(label,i))out+='\\';out+=label[i];}return out;};
function escapedBefore(text,index){let n=0;while(index>0&&text[--index]==='\\')n++;return n%2===1;}
function linkMarkdown(label,url,image=false){return `${image?'!':''}[${escapeLabel(label)}](<${url}>)`;}
// Adjacent elements with the same mark merge (**a****b** would misread), and an emphasis that would touch another
// "*" run switches to "_"/"__" where underscores are valid (not inside a word).
function serializeNodes(nodes){
 const parts=[];
 for(const node of nodes){const mark=nodeMark(node),last=parts.at(-1);if(mark&&mark!=='code'&&last&&last.mark===mark){last.nodes.push(node);continue;}parts.push({mark,nodes:[node]});}
 for(const part of parts){
  if(MARKERS[part.mark]){part.inner=part.nodes.map(n=>serializeNodes([...(n.childNodes||[])])).join('');part.md=emphasize(part.inner,MARKERS[part.mark]);}
  else part.md=part.nodes.map(fromNode).join('');
 }
 for(let k=0;k<parts.length;k++){
  const part=parts[k];if((part.mark!=='bold'&&part.mark!=='italic')||part.md===part.inner)continue;
  const before=parts[k-1]?.md.at(-1),after=parts[k+1]?.md[0],lead=/^\s/.test(part.md),trail=/\s$/.test(part.md);
  if(!((before==='*'&&!lead)||(after==='*'&&!trail)))continue;
  if((lead||!WORD.test(before||''))&&(trail||!WORD.test(after||'')))part.md=emphasize(part.inner,part.mark==='bold'?'__':'_');
 }
 return parts.map(part=>part.md).join('');
}
function styleMarks(node){const style=String(attr(node,'style')||'').toLowerCase(),marks=[];if(/font-weight\s*:\s*(?:bold|[6-9]00)\b/.test(style))marks.push('bold');if(/font-style\s*:\s*italic/.test(style))marks.push('italic');if(/text-decoration[^;]*line-through/.test(style))marks.push('strike');return marks;}
function fromNode(node){
 if(node.nodeType===3)return escapeText(node.textContent);
 if(node.nodeType===11)return serializeNodes([...(node.childNodes||[])]);
 if(node.nodeType!==1)return '';
 const tag=tagOf(node),classes=classesOf(node);
 if(classes.includes('note-link')&&attr(node,'data-target')){const label=attr(node,'data-label');return `[[${attr(node,'data-target')}${label?'|'+label:''}]]`;}
 if(classes.includes('ai-citation')&&attr(node,'data-id'))return `[[${attr(node,'data-id')}]]`;
 if(tag==='BR')return '\n';
 if(tag==='CODE'||tag==='KBD'||tag==='SAMP'||tag==='TT')return codeSpan(rawText(node).replace(/\n/g,' '));
 if(nodeMark(node))return serializeNodes([node]);
 if(tag==='A'){
  const auto=attr(node,'data-autolink');if(auto)return auto==='angle'?`<${rawText(node)}>`:rawText(node);
  const href=safeMarkdownUrl(attr(node,'href')),image=classes.includes('markdown-media-link'),kids=[...(node.childNodes||[])],shown=rawText(node).trim();
  if(href&&!image&&/^https?:\/\/./i.test(shown)&&safeMarkdownUrl(shown)===href&&trimAutolink(shown)===shown&&!/[\s<>"'`]/.test(shown))return shown;
  const label=image?serializeNodes(kids.slice(1)):serializeNodes(kids);
  return href?linkMarkdown(label||escapeText(href),href,image):label;
 }
 if(tag==='IMG'){const src=safeMarkdownUrl(attr(node,'src')),alt=escapeText(attr(node,'alt')||'');return src&&/^https?:/.test(src)?linkMarkdown(alt||'Image',src,true):alt;}
 if(tag==='SPAN'){let md=serializeNodes([...(node.childNodes||[])]);for(const mark of styleMarks(node))md=emphasize(md,MARKERS[mark]);return md;}
 if(['SCRIPT','STYLE','TEMPLATE','SVG','INPUT','BUTTON','SELECT','TEXTAREA'].includes(tag))return '';
 if(tag==='DIV'||tag==='P')return '\n'+serializeNodes([...(node.childNodes||[])]);
 return serializeNodes([...(node.childNodes||[])]);
}
export function serializeInlineFragment(fragment){return fromNode(fragment);}

// Markdown typed at the start of a block: the plain text before the caret (including the space just typed).
export function matchBlockShortcut(text){
 const value=String(text??'').replace(/\u00a0/g,' ');let m;
 if((m=/^(#{1,3}) $/.exec(value)))return {type:'h'+m[1].length};
 if(/^[-*+] $/.test(value))return {type:'bullet'};
 if((m=/^(\d{1,9})[.)] $/.exec(value)))return {type:'number',ordinal:Number(m[1])};
 if(/^\[ ?\] $/.test(value))return {type:'todo',checked:false};
 if(/^\[[xX]\] $/.test(value))return {type:'todo',checked:true};
 if(/^>! $/.test(value))return {type:'callout',kind:'note'};
 if(/^[>"] $/.test(value))return {type:'quote'};
 if(value==='```')return {type:'code'};
 if(value==='---')return {type:'divider'};
 return null;
}
// Closing inline Markdown typed in one text run: text is everything before the caret, ending with the typed character.
export function matchInlineShortcut(text){
 const value=String(text??'');
 for(const [mark,re] of [
  ['bold',/(^|[^*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/u],['bold',/(^|[^_\\\p{L}\p{N}])__([^_\s](?:[^_]*[^_\s])?)__$/u],
  ['strike',/(^|[^~\\])~~([^~\s](?:[^~]*[^~\s])?)~~$/u],['code',/(^|[^`\\])`([^`]+)`$/u],
  ['italic',/(^|[^*\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/u],['italic',/(^|[^_\\\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_$/u]
 ]){const m=re.exec(value);if(m)return {mark,start:m.index+m[1].length,end:value.length,text:m[2]};}
 const link=/(^|[^\\!])\[([^\]\n]+)\]\(([^()\s]+)\)$/.exec(value);
 if(link){const href=safeMarkdownUrl(link[3]);if(href)return {mark:'link',start:link.index+link[1].length,end:value.length,text:link[2],href};}
 return null;
}

// HTML (clipboard) to Markdown, dependency-free so it behaves the same in Node and in the page. Unknown or unsafe
// markup degrades to text; scripts, styles and embedded media are dropped and images become links.
const VOID=new Set(['AREA','BASE','BR','COL','EMBED','HR','IMG','INPUT','LINK','META','SOURCE','TRACK','WBR']);
const DROP=new Set(['SCRIPT','STYLE','HEAD','TITLE','TEMPLATE','NOSCRIPT','SVG','MATH','IFRAME','OBJECT','CANVAS','SELECT','TEXTAREA','BUTTON','VIDEO','AUDIO']);
const BLOCK_TAGS=new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BODY','CENTER','DD','DETAILS','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','HTML','LI','MAIN','NAV','OL','P','PRE','SECTION','SUMMARY','TABLE','TBODY','TD','TFOOT','TH','THEAD','TR','UL']);
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0',ndash:'–',mdash:'—',hellip:'…',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',bull:'•',middot:'·',copy:'©',reg:'®',trade:'™',times:'×',laquo:'«',raquo:'»'};
const decodeEntities=value=>value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi,(m,e)=>{if(e[0]==='#'){const code=/^#x/i.test(e)?parseInt(e.slice(2),16):Number(e.slice(1));return code>0&&code<0x110000?String.fromCodePoint(code):m;}return ENTITIES[e.toLowerCase()]??m;});
const htmlElement=(tagName,attrs)=>({nodeType:1,tagName,attrs,childNodes:[],getAttribute:name=>attrs[String(name).toLowerCase()]??null});
function parseHtml(html){
 const root={nodeType:11,tagName:'#root',childNodes:[]},stack=[root];let skip=null,last=0,m;
 const current=()=>stack.at(-1);
 const text=value=>{if(value&&!skip)current().childNodes.push({nodeType:3,textContent:decodeEntities(value)});};
 const popTo=(tags,stops)=>{for(let i=stack.length-1;i>0;i--){const tag=stack[i].tagName;if(stops.includes(tag))return;if(tags.includes(tag)){stack.length=i;return;}}};
 const re=/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
 while((m=re.exec(html))){
  text(html.slice(last,m.index));last=re.lastIndex;
  if(m[1]){const tag=m[1].toUpperCase();if(skip){if(tag===skip)skip=null;continue;}for(let i=stack.length-1;i>0;i--)if(stack[i].tagName===tag){stack.length=i;break;}continue;}
  if(!m[2]||skip)continue;
  const tag=m[2].toUpperCase(),attrs={};for(const a of (m[3]||'').matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))attrs[a[1].toLowerCase()]=decodeEntities(a[2]??a[3]??a[4]??'');
  // AI source chips (copied from a rendered answer) are buttons; they become [[id]] instead of being dropped.
  const citation=tag==='BUTTON'&&/(?:^|\s)ai-citation(?:\s|$)/.test(attrs.class||'')&&/^[\w:.-]{1,200}$/.test(attrs['data-id']||'');
  if(DROP.has(tag)&&!citation){if(!m[4]&&!VOID.has(tag))skip=tag;continue;}
  if(tag==='LI')popTo(['LI'],['UL','OL']);
  if(tag==='DT'||tag==='DD')popTo(['DT','DD'],['DL']);
  if(tag==='TD'||tag==='TH')popTo(['TD','TH'],['TR','TABLE']);
  if(tag==='TR')popTo(['TR'],['TABLE','TBODY','THEAD','TFOOT']);
  if(BLOCK_TAGS.has(tag)&&current().tagName==='P')stack.pop();
  const el=htmlElement(tag,attrs);current().childNodes.push(el);if(!VOID.has(tag)&&!m[4])stack.push(el);
 }
 text(html.slice(last));
 return root;
}
const collapseWhitespace=node=>node.nodeType===3?{nodeType:3,textContent:String(node.textContent).replace(/[\t\n\r\f ]+/g,' ')}:node.nodeType===1&&tagOf(node)!=='PRE'?{...node,childNodes:node.childNodes.map(collapseWhitespace)}:node;
const hasBlock=node=>node.nodeType===1&&node.childNodes.some(child=>child.nodeType===1&&(BLOCK_TAGS.has(child.tagName)||hasBlock(child)));
function inlineMarkdown(nodes){return serializeNodes(nodes.map(collapseWhitespace)).split('\n').map(line=>line.replace(/^ +| +$/g,'')).join('\n').replace(/^\n+|\n+$/g,'');}
const blockText=b=>b.type==='table'?[b.headers,...b.rows].map(r=>r.join(' ')).join('\n'):b.type==='toggle'?b.title:b.text||'';
function calloutKindOf(node){const cls=classesOf(node).join(' '),m=/markdown-alert-(note|tip|important|warning|caution)/.exec(cls);if(m)return m[1];if(/\bmarkdown-callout\b/.test(cls))return CALLOUT_KINDS[attr(node,'data-kind')]?attr(node,'data-kind'):'note';return null;}
function htmlBlocks(nodes,indent=0){
 const blocks=[];let run=[];
 const flush=()=>{if(!run.length)return;const text=inlineMarkdown(run);run=[];if(text.trim())blocks.push({type:'paragraph',text});};
 for(const node of nodes){
  if(node.nodeType!==1){if(node.nodeType===3)run.push(node);continue;}
  const tag=node.tagName,classes=classesOf(node);
  if(!BLOCK_TAGS.has(tag)){if(hasBlock(node)){flush();blocks.push(...htmlBlocks(node.childNodes,indent));}else run.push(node);continue;}
  flush();
  if(/^H[1-6]$/.test(tag)){const text=inlineMarkdown(node.childNodes).replace(/\s*\n\s*/g,' ');if(text)blocks.push({type:'h'+Math.min(3,Number(tag[1])),text});continue;}
  if(tag==='HR'){blocks.push({type:'divider',text:''});continue;}
  if(tag==='PRE'){const code=node.childNodes.find(c=>c.nodeType===1&&c.tagName==='CODE'),info=`${attr(code||{},'class')||''} ${attr(node,'class')||''}`;blocks.push({type:'code',text:rawText(node).replace(/\n$/,''),language:attr(code||{},'data-language')||attr(node,'data-language')||(/(?:language|lang)-([\w+#.-]+)/.exec(info)||[])[1]||''});continue;}
  if(tag==='UL'||tag==='OL'){listBlocks(node,indent,blocks);continue;}
  const kind=calloutKindOf(node);
  if(kind||tag==='BLOCKQUOTE'){const inner=htmlBlocks(node.childNodes.filter(c=>!(c.nodeType===1&&/markdown-(?:alert|callout)-title/.test(classesOf(c).join(' ')))),indent);const text=inner.map(blockText).join('\n');if(text.trim()||kind)blocks.push(kind?{type:'callout',kind,text}:{type:'quote',text});continue;}
  if(classes.includes('task-line')){const box=node.childNodes.find(c=>c.nodeType===1&&tagOf(c)==='INPUT');const text=inlineMarkdown(node.childNodes.filter(c=>c!==box&&!classesOf(c).includes('task-check')));blocks.push({type:'todo',text,checked:box?attr(box,'checked')!==null:classes.includes('done'),indent});continue;}
  if(tag==='TABLE'){const rows=[];const collect=el=>{for(const child of el.childNodes){if(child.nodeType!==1)continue;if(child.tagName==='TR')rows.push(child.childNodes.filter(c=>c.nodeType===1&&(c.tagName==='TD'||c.tagName==='TH')).map(c=>inlineMarkdown(c.childNodes)));else if(['THEAD','TBODY','TFOOT'].includes(child.tagName))collect(child);}};collect(node);if(rows.length)blocks.push({type:'table',text:'',headers:rows[0],rows:rows.slice(1),alignments:[]});continue;}
  if(tag==='DETAILS'){const summary=node.childNodes.find(c=>c.nodeType===1&&c.tagName==='SUMMARY');blocks.push({type:'toggle',title:summary?inlineMarkdown(summary.childNodes).replace(/\n/g,' ')||'Toggle':'Toggle',text:serializeNoteBlocks(htmlBlocks(node.childNodes.filter(c=>c!==summary))),open:attr(node,'open')!==null});continue;}
  blocks.push(...htmlBlocks(node.childNodes,indent));
 }
 flush();return blocks;
}
function listBlocks(list,indent,blocks){
 let first=true;const start=Number(attr(list,'start'));
 for(const item of list.childNodes){
  if(item.nodeType!==1)continue;
  if(item.tagName==='UL'||item.tagName==='OL'){listBlocks(item,indent+1,blocks);continue;}
  const nested=[],content=[];let checked=null;
  const box=node=>node.nodeType===1&&node.tagName==='INPUT'&&String(attr(node,'type')).toLowerCase()==='checkbox';
  for(const child of item.childNodes){
   if(child.nodeType===1&&(child.tagName==='UL'||child.tagName==='OL')){nested.push(child);continue;}
   if(checked===null&&!rawText({nodeType:11,childNodes:content}).trim()){const found=box(child)?child:child.nodeType===1&&['P','LABEL','SPAN'].includes(child.tagName)?child.childNodes.find(box):null;if(found){checked=attr(found,'checked')!==null;if(found!==child)content.push({...child,childNodes:child.childNodes.filter(c=>c!==found)});continue;}}
   content.push(child);
  }
  const text=htmlBlocks(content,indent).map(blockText).join('\n');
  const block={type:checked!==null?'todo':list.tagName==='OL'?'number':'bullet',text,checked:!!checked,indent};
  if(block.type==='number'&&first&&Number.isSafeInteger(start)&&start>0)block.ordinal=start;
  first=false;blocks.push(block);
  for(const child of nested)listBlocks(child,indent+1,blocks);
 }
}
export function htmlToMarkdown(html){
 let source=String(html??'');const fragment=/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(source);if(fragment)source=fragment[1];
 const blocks=htmlBlocks(parseHtml(source).childNodes);
 return blocks.length?serializeNoteBlocks(blocks):'';
}

const MD_MIME='text/x-still-markdown';
const LIST=new Set(['bullet','number','todo']),TEXT=new Set(['paragraph','h1','h2','h3','bullet','number','todo','quote','callout','code']);
const MODES=[['blocks','Blocks'],['markdown','Markdown'],['preview','Preview']];
const PLACEHOLDERS={h1:'Heading 1',h2:'Heading 2',h3:'Heading 3',bullet:'List',number:'List',todo:'To-do',quote:'Quote',callout:'Callout'};
const TYPE_ICONS={note:'note',bookmark:'bookmark',article:'note',image:'image',video:'file',file:'file'};
const RICH_HTML=/<(?:(?:h[1-6]|ul|ol|li|blockquote|pre|table|hr|strong|em|del|s|code|details|b|i|p)(?:\s[^>]*)?|a\s[^>]*href[^>]*)>/i;
const freshBlock=(type='paragraph',extra={})=>({id:uid(),type,text:'',checked:false,language:'',...(LIST.has(type)?{indent:0}:{}),...extra});
const pasteBlocks=source=>{const parsed=parseNoteBlocks(String(source).replace(/\r\n?/g,'\n')).map(b=>{const copy={id:uid()};for(const [k,v] of Object.entries(b))if(k!=='id'&&!k.startsWith('_'))copy[k]=v;return copy;});const blank=b=>b.type==='paragraph'&&!b.text.trim();while(parsed.length&&blank(parsed[0]))parsed.shift();while(parsed.length&&blank(parsed.at(-1)))parsed.pop();return parsed;};

export function mountBlockEditor(textarea,options={}){
 const doc=textarea.ownerDocument,win=doc.defaultView;
 const onChange=typeof options.onChange==='function'?options.onChange:()=>{};
 const onAskAi=typeof options.onAskAi==='function'?options.onAskAi:null;
 const searchLinks=typeof options.searchLinks==='function'?options.searchLinks:null;
 const resolveLink=typeof options.resolveLink==='function'?options.resolveLink:()=>null;
 const onOpenLink=typeof options.onOpenLink==='function'?options.onOpenLink:()=>{};
 const onSelectionChange=typeof options.onSelectionChange==='function'?options.onSelectionChange:null;
 const placeholder=options.placeholder||'Write, or press / for blocks';
 const isMac=/Mac|iPhone|iPad/.test(win.navigator?.platform||'');
 const modKey=isMac?'⌘':'Ctrl+';
 const domId='be'+uid().replace(/-/g,'').slice(0,8);
 let mode=MODES.some(m=>m[0]===options.mode)?options.mode:'blocks';
 let blocks=parseNoteBlocks(textarea.value),lastSnapshot=textarea.value,setting=false,composing=false;
 let activeId=blocks[0].id,lastRange=null,caretBefore=null,lastEdit={at:0,since:0,id:null,coalesce:false,source:''};
 let undoStack=[],redoStack=[],selected=new Set(),anchorId=null,focusId=null;
 let popupState=null,linkTarget=null,drag=null,textDrag=false,dragSelect=null,searchSeq=0,searchTimer=0,selFrame=0;
 const editingToggles=new Set(),baselines=new WeakMap(),drawn=new Map(),listeners=[];
 const on=(target,type,fn,opts)=>{target.addEventListener(type,fn,opts);listeners.push([target,type,fn,opts]);};

 const root=doc.createElement('div');root.className='block-editor';root.dataset.mode=mode;if(options.compact)root.dataset.compact='';
 const shortcut=key=>isMac?modKey+key:modKey+key;
 const ariaKeys=key=>(isMac?'Meta+':'Control+')+key;
 const toolbarButton=(mark,label,keys,name,aria)=>`<button type="button" class="block-editor-tool" data-format="${mark}" aria-label="${label}" aria-pressed="false" aria-keyshortcuts="${aria}" data-tooltip="${label} ${keys}">${icon(name)}</button>`;
 root.innerHTML=`${options.showModeSwitch===false?'':`<div class="block-editor-bar"><div class="block-editor-modes" role="group" aria-label="Editor view">${MODES.map(([id,label])=>`<button type="button" class="block-editor-mode" data-editor-mode="${id}" aria-pressed="${id===mode}">${label}</button>`).join('')}</div></div>`}
<div class="block-editor-status" role="status" aria-live="polite"></div>
<div class="block-list" role="group" aria-label="Note content" tabindex="-1"></div>
<div class="block-editor-preview markdown-body" tabindex="-1" hidden></div>
<div class="block-editor-source" hidden></div>
<div class="block-editor-float block-editor-popup" id="${domId}-popup" role="listbox" hidden></div>
<div class="block-editor-float block-editor-toolbar" role="toolbar" aria-label="Text formatting" hidden>${toolbarButton('bold','Bold',shortcut('B'),'bold',ariaKeys('B'))}${toolbarButton('italic','Italic',shortcut('I'),'italic',ariaKeys('I'))}${toolbarButton('strike','Strikethrough',isMac?'⌘⇧X':'Ctrl+Shift+X','strike',ariaKeys('Shift+X'))}${toolbarButton('code','Code',shortcut('E'),'inlineCode',ariaKeys('E'))}${toolbarButton('link','Link',shortcut('K'),'link',ariaKeys('K'))}${onAskAi?`<span class="block-editor-tool-separator" aria-hidden="true"></span><button type="button" class="block-editor-tool block-editor-tool-ai" data-editor-action="ask-ai">${icon('ai')}<span>Ask AI</span></button>`:''}</div>
<div class="block-editor-float block-editor-linkform" role="dialog" aria-label="Link" hidden><label class="block-editor-field" data-link-label-field><span>Text</span><input data-link-label type="text" maxlength="500" autocomplete="off"></label><label class="block-editor-field"><span>Link</span><input data-link-url type="url" placeholder="https://" autocomplete="off" spellcheck="false"></label><p class="block-editor-linkform-error" role="alert" hidden></p><div class="block-editor-linkform-actions"><button type="button" class="block-editor-btn" data-editor-action="link-remove" hidden>Remove link</button><span></span><button type="button" class="block-editor-btn" data-editor-action="link-cancel">Cancel</button><button type="button" class="block-editor-btn is-primary" data-editor-action="link-save">Save</button></div></div>`;
 textarea.before(root);
 const $=selector=>root.querySelector(selector);
 const list=$('.block-list'),preview=$('.block-editor-preview'),sourceWrap=$('.block-editor-source'),status=$('.block-editor-status');
 const popup=$('.block-editor-popup'),toolbar=$('.block-editor-toolbar'),linkForm=$('.block-editor-linkform');
 sourceWrap.append(textarea);textarea.hidden=false;textarea.classList.add('block-editor-textarea');if(!textarea.getAttribute('aria-label')&&!textarea.labels?.length)textarea.setAttribute('aria-label','Markdown source');
 const indicator=doc.createElement('div');indicator.className='block-drop-indicator';indicator.hidden=true;
 const usePopover=typeof win.HTMLElement?.prototype.showPopover==='function';
 for(const el of [popup,toolbar,linkForm])if(usePopover)el.setAttribute('popover','manual');
 const showFloat=el=>{el.hidden=false;if(usePopover&&!el.matches(':popover-open'))try{el.showPopover();}catch{}};
 const hideFloat=el=>{if(usePopover&&el.matches(':popover-open'))try{el.hidePopover();}catch{}el.hidden=true;};
 const report=message=>{status.textContent=message||'';};

 // Model helpers
 const block=id=>blocks.find(b=>b.id===id);
 const indexOf=id=>blocks.findIndex(b=>b.id===id);
 const blockEl=id=>{const el=drawn.get(id)?.el;return el&&el.parentNode===list?el:null;};
 const editableOf=id=>blockEl(id)?.querySelector('[data-block-edit]')||null;
 const docEmpty=()=>blocks.length===1&&blocks[0].type==='paragraph'&&!blocks[0].text;
 const inlineHtml=text=>renderInline(text,{resolveLink}).replace(/<(a|span) class="note-link/g,'<$1 contenteditable="false" class="note-link');
 // A trailing <br> only makes an empty last line visible; it is not part of the text.
 const withoutSentinel=(el,text)=>el.lastChild?.nodeName==='BR'?text.replace(/\n$/,''):text;
 const editableMarkdown=el=>serializeNodes([...el.childNodes]);
 function textLength(text){const box=doc.createElement('div');box.innerHTML=inlineHtml(text);return visibleLength(box);}
 // Joins inline Markdown pieces through the DOM so adjacent formatting merges instead of colliding (**a****b**).
 function joinMarkdown(...parts){const box=doc.createElement('div');box.innerHTML=parts.map(inlineHtml).join('');return editableMarkdown(box);}
 // Re-parsed blocks whose source is unchanged keep their old ids, so the keyed render keeps their elements.
 function reparse(markdown){
  const pool=new Map(),next=parseNoteBlocks(markdown);
  serializeBlockParts(blocks).forEach((part,i)=>{const key=part.replace(/^\n/,''),ids=pool.get(key);if(ids)ids.push(blocks[i].id);else pool.set(key,[blocks[i].id]);});
  for(const b of next){const ids=pool.get(b._raw);if(ids?.length)b.id=ids.shift();}
  return next;
 }
 function normalizeIndents(){let previous=null;for(const b of blocks){if(LIST.has(b.type)){const max=previous&&LIST.has(previous.type)?(Number(previous.indent)||0)+1:0;if((Number(b.indent)||0)>max)b.indent=max;else if(b.indent===undefined)b.indent=0;}previous=b;}}

 // Undo history: snapshots of the Markdown plus the caret. Typing in one block is one step until a 1.2s pause, at most 5s.
 const COALESCE_PAUSE=1200,COALESCE_SPAN=5000;
 function beginChange(){if(!caretBefore)caretBefore=caretState();}
 function emit(value){setting=true;try{textarea.value=value;textarea.dispatchEvent(new win.Event('input',{bubbles:true}));}finally{setting=false;}onChange(value);}
 function commit({coalesce=false}={}){
  normalizeIndents();const value=serializeNoteBlocks(blocks);
  if(value===lastSnapshot){caretBefore=null;return false;}
  if(status.textContent)report('');
  const now=Date.now(),merge=coalesce&&lastEdit.coalesce&&lastEdit.source==='blocks'&&lastEdit.id===activeId&&now-lastEdit.at<COALESCE_PAUSE&&now-lastEdit.since<COALESCE_SPAN&&undoStack.length;
  if(!merge){undoStack.push({md:lastSnapshot,caret:caretBefore});if(undoStack.length>200)undoStack.shift();}
  redoStack=[];lastSnapshot=value;lastEdit={at:now,since:merge?lastEdit.since:now,id:activeId,coalesce,source:'blocks'};caretBefore=null;
  emit(value);return true;
 }
 function applySnapshot(entry){
  blocks=reparse(entry.md);lastSnapshot=entry.md;lastEdit={at:0,since:0,id:null,coalesce:false,source:''};caretBefore=null;
  closePopup();hideToolbar();closeLinkForm();clearSelection(false);emit(entry.md);
  if(mode==='blocks'){render();restoreCaret(entry.caret);}else if(mode==='preview')renderPreview();else autosize();
 }
 function undo(){readAll();const entry=undoStack.pop();if(!entry)return false;redoStack.push({md:lastSnapshot,caret:caretState()});applySnapshot(entry);return true;}
 function redo(){readAll();const entry=redoStack.pop();if(!entry)return false;undoStack.push({md:lastSnapshot,caret:caretState()});applySnapshot(entry);return true;}

 // Caret positions are counted in visible characters (a <br> counts one, zero-width spaces count none).
 function visibleLength(node){if(node.nodeType===3)return node.data.replace(ZWSP,'').length;if(node.nodeType!==1&&node.nodeType!==11)return 0;if(node.nodeName==='BR')return 1;let n=0;for(const child of node.childNodes)n+=visibleLength(child);return n;}
 const contentLength=el=>visibleLength(el)-(el.lastChild?.nodeName==='BR'?1:0);
 function offsetIn(el,container,offset){const range=doc.createRange();range.selectNodeContents(el);try{range.setEnd(container,offset);}catch{return 0;}return visibleLength(range.cloneContents());}
 function pointAt(el,offset){
  let remaining=Math.max(0,offset);const at=node=>[...node.parentNode.childNodes].indexOf(node);
  const walk=node=>{
   for(const child of node.childNodes){
    if(child.nodeType===3){const len=child.data.replace(ZWSP,'').length;if(remaining<=len){let raw=0,seen=0;while(raw<child.data.length&&(seen<remaining||child.data[raw]==='\u200b')){if(child.data[raw]!=='\u200b')seen++;raw++;}return {node:child,offset:raw};}remaining-=len;continue;}
    if(child.nodeType!==1)continue;
    if(child.nodeName==='BR'){if(remaining===0)return {node,offset:at(child)};remaining-=1;continue;}
    if(child.getAttribute('contenteditable')==='false'){const len=child.textContent.length;if(remaining===0)return {node,offset:at(child)};if(remaining<=len)return {node,offset:at(child)+1};remaining-=len;continue;}
    const hit=walk(child);if(hit)return hit;
   }
   return null;
  };
  return walk(el)||{node:el,offset:el.childNodes.length};
 }
 function placeCaret(el,start,end=start){const a=pointAt(el,start),z=end===start?a:pointAt(el,end),range=doc.createRange();range.setStart(a.node,a.offset);range.setEnd(z.node,z.offset);const sel=win.getSelection();sel.removeAllRanges();sel.addRange(range);}
 function selectionOffsets(el){const sel=win.getSelection();if(!sel.rangeCount)return {start:0,end:0,inside:false};const r=sel.getRangeAt(0);if(!el.contains(r.startContainer)||!el.contains(r.endContainer))return {start:0,end:0,inside:false};return {start:offsetIn(el,r.startContainer,r.startOffset),end:offsetIn(el,r.endContainer,r.endOffset),inside:true};}
 function rangeMarkdown(el,from,to){if(to<=from)return '';const a=pointAt(el,from),z=pointAt(el,to),range=doc.createRange();range.setStart(a.node,a.offset);range.setEnd(z.node,z.offset);return serializeInlineFragment(range.cloneContents());}
 function selectionEditable(){const sel=win.getSelection();const node=sel.rangeCount?sel.anchorNode:null;const el=node&&(node.nodeType===1?node:node.parentElement)?.closest?.('[data-block-edit]');return el&&list.contains(el)?el:null;}
 function caretState(){
  if(selected.size)return {index:indexOf(orderedSelection()[0]),start:0,end:0};
  const el=selectionEditable();if(el){const {start,end}=selectionOffsets(el);return {index:indexOf(el.dataset.blockEdit),start,end};}
  const index=indexOf(activeId);return index<0?null:{index,start:null,end:null};
 }
 function restoreCaret(state){const b=blocks[Math.max(0,Math.min(state?.index??0,blocks.length-1))];if(b)focusBlock(b.id,state&&state.start!==null&&state.start!==undefined?{start:state.start,end:state.end}:{at:'end'});}
 function caretRect(){const sel=win.getSelection();if(!sel.rangeCount)return null;const r=sel.getRangeAt(0).cloneRange();r.collapse(true);const rect=[...r.getClientRects()].find(x=>x.height>0);if(rect)return rect;const node=r.startContainer.nodeType===1?r.startContainer.childNodes[r.startOffset]||r.startContainer:r.startContainer.parentElement;if(node?.nodeType===1&&node.nodeName!=='BR'){const box=node.getBoundingClientRect();return {left:box.left,right:box.left,top:box.top,bottom:box.top+(parseFloat(win.getComputedStyle(node).lineHeight)||20),height:20};}return null;}
 function lineEdge(el,first){
  const sel=win.getSelection();if(!sel.rangeCount)return true;const r=sel.getRangeAt(0).cloneRange();r.collapse(first);
  const rect=[...r.getClientRects()].find(x=>x.height>0);const {start,end}=selectionOffsets(el);
  if(!rect)return first?start===0:end>=contentLength(el);
  const box=el.getBoundingClientRect(),style=win.getComputedStyle(el),lh=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.5||20;
  return first?rect.top<box.top+parseFloat(style.paddingTop)+lh*0.8:rect.bottom>box.bottom-parseFloat(style.paddingBottom)-lh*0.8;
 }

 // Rendering
 function editableMarkup(b){
  const empty=!b.text,label=BLOCK_COMMANDS.find(c=>c[0]===b.type)?.[1]||'Text';
  const ph=b.type==='paragraph'?(docEmpty()?placeholder:'Type / for blocks'):PLACEHOLDERS[b.type]||'';
  const html=b.type==='code'?esc(b.text)+(b.text.endsWith('\n')?'<br>':''):inlineHtml(b.text)+(b.text.endsWith('\n')?'<br>':'');
  return `${b.type==='code'?`<input class="block-code-lang" data-code-lang="${b.id}" value="${esc(b.language||'')}" placeholder="Language" aria-label="Code language" spellcheck="false" autocomplete="off">`:''}<div class="block-editable${empty?' is-empty':''}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${esc(label)}" data-block-edit="${b.id}" data-placeholder="${esc(ph)}" spellcheck="${b.type==='code'?'false':'true'}"${b.type==='code'?' translate="no"':''}>${html}</div>`;
 }
 function tableMarkup(b){
  const width=tableWidth(b),cell=(value,row,column)=>`<${row<0?'th scope="col"':'td'}><div contenteditable="true" role="textbox" aria-multiline="true" aria-label="${row<0?'Header':`Row ${row+1},`} column ${column+1}" data-table-cell="${b.id}" data-cell-row="${row}" data-cell-column="${column}" spellcheck="true">${renderTableCell(value||'',{resolveLink})}</div></${row<0?'th':'td'}>`;
  return `<div class="rich-table" role="group" aria-label="Table"><div class="rich-table-scroll"><table><thead><tr>${Array.from({length:width},(_,i)=>cell(b.headers[i],-1,i)).join('')}</tr></thead><tbody>${b.rows.map((row,r)=>'<tr>'+Array.from({length:width},(_,c)=>cell(row[c],r,c)).join('')+'</tr>').join('')}</tbody></table></div><div class="rich-table-tools" role="toolbar" aria-label="Table"><button type="button" class="block-editor-btn" data-table-action="add-row" data-table-id="${b.id}">Add row</button><button type="button" class="block-editor-btn" data-table-action="add-column" data-table-id="${b.id}">Add column</button><button type="button" class="block-editor-btn" data-table-action="remove-row" data-table-id="${b.id}"${b.rows.length?'':' disabled'}>Remove row</button><button type="button" class="block-editor-btn" data-table-action="remove-column" data-table-id="${b.id}"${width===1?' disabled':''}>Remove column</button><span class="rich-block-hint">Tab moves between cells. Shift+Enter adds a line.</span></div></div>`;
 }
 // A toggle is a disclosure button, a title field and a body (raw Markdown while editing, rendered otherwise).
 // It is not a <details>: the title input cannot live inside an interactive <summary>.
 function toggleMarkup(b){
  const editing=editingToggles.has(b.id),body=`${domId}-toggle-${b.id}`;
  return `<div class="rich-toggle" data-toggle-id="${b.id}"><div class="rich-toggle-head"><button type="button" class="rich-toggle-chevron" data-toggle-open="${b.id}" aria-expanded="${b.open}" aria-controls="${body}" aria-label="${b.open?'Hide':'Show'} toggle content">${icon('toggle')}</button><input type="text" data-toggle-title="${b.id}" value="${esc(b.title)}" aria-label="Toggle title" placeholder="Toggle"></div><div class="rich-toggle-content" id="${body}"${b.open?'':' hidden'}>${editing?`<textarea data-toggle-body="${b.id}" aria-label="Toggle content in Markdown" spellcheck="true" rows="4">${esc(b.text)}</textarea>`:`<div class="rich-toggle-preview markdown-body">${b.text.trim()?renderMarkdown(b.text,{resolveLink}):'<p class="rich-block-hint">Empty toggle.</p>'}</div>`}<div class="rich-toggle-tools"><button type="button" class="block-editor-btn" data-toggle-edit="${b.id}">${editing?'Done':'Edit content'}</button></div></div></div>`;
 }
 function blockHtml(b,number){
  const indent=LIST.has(b.type)?Math.max(0,Number(b.indent)||0):0,kind=CALLOUT_KINDS[b.kind]?b.kind:'note';
  let marker='',content;
  if(b.type==='todo')marker=`<span class="block-marker" contenteditable="false"><input type="checkbox" class="block-check" data-block-check="${b.id}"${b.checked?' checked':''} aria-label="${esc(inlineText(b.text)||'To-do')}"></span>`;
  else if(b.type==='bullet')marker='<span class="block-marker" contenteditable="false" aria-hidden="true"><span class="block-dot"></span></span>';
  else if(b.type==='number')marker=`<span class="block-marker" contenteditable="false" aria-hidden="true">${number}.</span>`;
  else if(b.type==='callout')marker=`<span class="block-marker" contenteditable="false"><button type="button" class="block-callout-kind" data-callout-kind="${b.id}" aria-label="Callout type: ${CALLOUT_KINDS[kind].label}" aria-haspopup="menu" data-tooltip="Change callout type">${calloutIcon(kind)}</button></span>`;
  if(b.type==='table')content=tableMarkup(b);
  else if(b.type==='toggle')content=toggleMarkup(b);
  else if(b.type==='divider')content='<div class="block-divider" contenteditable="false" role="separator"><hr></div>';
  else content=editableMarkup(b);
  const gutter=`<div class="block-gutter" contenteditable="false"><button type="button" class="block-handle" data-block-add="${b.id}" tabindex="-1" aria-label="Add a block below" data-tooltip="Add a block below">${icon('plus')}</button><button type="button" class="block-handle block-handle-drag" data-block-drag="${b.id}" draggable="true" tabindex="-1" aria-label="Block options" data-tooltip="Drag to move, click for options">${icon('grip')}</button></div>`;
  return `<div class="note-block block-${b.type}${selected.has(b.id)?' is-selected':''}${b.type==='todo'&&b.checked?' is-checked':''}" data-block-id="${b.id}" data-type="${b.type}"${b.type==='callout'?` data-kind="${kind}"`:''}${indent?` style="--indent:${indent}"`:''}>${gutter}${marker}${content}</div>`;
 }
 function remember(el){const b=block(el.dataset.blockEdit);if(b)baselines.set(el,{html:el.innerHTML,text:b.text});}
 // Keyed render: a block keeps its element while its markup is unchanged, so structural edits in long notes only
 // rebuild the blocks they touch. Selection classes are painted afterwards because paintSelection changes them in place.
 function drawBlock(b,number){
  const html=blockHtml(b,number),known=drawn.get(b.id);if(known&&known.html===html&&known.el.isConnected)return known.el;
  const template=doc.createElement('template');template.innerHTML=html;const el=template.content.firstElementChild;
  if(known?.el.isConnected)known.el.replaceWith(el);drawn.set(b.id,{el,html});const ed=el.querySelector('[data-block-edit]');if(ed)remember(ed);return el;
 }
 function render(){
  normalizeIndents();const numbers=listNumbers(blocks),ids=new Set(blocks.map(b=>b.id));
  for(const [id,entry] of drawn)if(!ids.has(id)){entry.el.remove();drawn.delete(id);}
  for(const el of [...list.children])if(el!==indicator&&!drawn.has(el.dataset.blockId))el.remove();
  let previous=null;
  blocks.forEach((b,i)=>{const el=drawBlock(b,numbers[i]),want=previous?previous.nextSibling:list.firstChild;if(el!==want)list.insertBefore(el,want);previous=el;});
  if(drag||!indicator.hidden)list.append(indicator);
  paintSelection();root.classList.toggle('is-empty',docEmpty());
 }
 function renderBlock(id){
  const index=indexOf(id);if(index<0||!drawn.get(id)?.el.isConnected)return render();
  const old=blockEl(id);drawn.delete(id);const el=drawBlock(blocks[index],listNumbers(blocks)[index]);old.replaceWith(el);
  paintSelection();root.classList.toggle('is-empty',docEmpty());
 }
 function updateEmpty(ed){const empty=!ed.textContent.replace(ZWSP,'')&&!ed.querySelector('[contenteditable="false"]');ed.classList.toggle('is-empty',empty);root.classList.toggle('is-empty',docEmpty());}
 function readBlock(el){
  const b=block(el.dataset.blockEdit);if(!b)return null;const base=baselines.get(el);if(base&&base.html===el.innerHTML)return b;
  b.text=withoutSentinel(el,b.type==='code'?rawText(el):editableMarkdown(el));
  baselines.set(el,{html:el.innerHTML,text:b.text});
  if(b.type==='todo')blockEl(b.id)?.querySelector('[data-block-check]')?.setAttribute('aria-label',inlineText(b.text)||'To-do');
  return b;
 }
 function readCell(el){const b=block(el.dataset.tableCell);if(!b||el.dataset.sourceEditing!=='true')return;const base=baselines.get(el);if(base?.html===el.innerHTML)return;const row=Number(el.dataset.cellRow),column=Number(el.dataset.cellColumn),values=row<0?b.headers:b.rows[row];if(!values)return;while(values.length<=column)values.push('');values[column]=el.innerText.replace(/\r\n?/g,'\n').replace(/\n$/,'');baselines.set(el,{html:el.innerHTML});}
 function readAll(){
  if(mode!=='blocks')return;
  for(const el of list.querySelectorAll('[data-block-edit]'))readBlock(el);
  for(const el of list.querySelectorAll('[data-table-cell]'))readCell(el);
  for(const el of list.querySelectorAll('[data-toggle-title]')){const b=block(el.dataset.toggleTitle);if(b)b.title=el.value.replace(/\r?\n/g,' ');}
  for(const el of list.querySelectorAll('[data-toggle-body]')){const b=block(el.dataset.toggleBody);if(b)b.text=el.value;}
  for(const el of list.querySelectorAll('[data-code-lang]')){const b=block(el.dataset.codeLang);if(b)b.language=el.value.trim();}
 }

 // Focus and block selection
 function focusBlock(id,{at='end',start,end,x,fromAbove=false}={}){
  const b=block(id),el=blockEl(id);if(!b||!el)return;activeId=id;
  if(b.type==='divider'){selectBlocks([id]);return;}
  if(selected.size)clearSelection();
  if(b.type==='table'){const cells=[...el.querySelectorAll('[data-table-cell]')];const cell=at==='start'||fromAbove?cells[0]:cells.filter(c=>c.dataset.cellRow===String(b.rows.length-1))[0]||cells.at(-1);focusCell(cell,at==='start'||fromAbove?'start':'end');return;}
  if(b.type==='toggle'){const title=el.querySelector('[data-toggle-title]');title?.focus();title?.setSelectionRange(at==='start'?0:title.value.length,at==='start'?0:title.value.length);return;}
  const ed=el.querySelector('[data-block-edit]');if(!ed)return;ed.focus({preventScroll:true});
  if(x!==undefined&&doc.caretRangeFromPoint){const box=ed.getBoundingClientRect(),style=win.getComputedStyle(ed),lh=parseFloat(style.lineHeight)||20,y=fromAbove?box.top+parseFloat(style.paddingTop)+lh/2:box.bottom-parseFloat(style.paddingBottom)-lh/2;const range=doc.caretRangeFromPoint(Math.max(box.left+1,Math.min(x,box.right-1)),y);if(range&&ed.contains(range.startContainer)){const sel=win.getSelection();sel.removeAllRanges();sel.addRange(range);ed.scrollIntoView?.({block:'nearest'});return;}}
  const length=contentLength(ed),s=Math.min(start??(at==='start'?0:length),visibleLength(ed));placeCaret(ed,s,Math.min(end??s,visibleLength(ed)));
  ed.scrollIntoView?.({block:'nearest'});
 }
 // Cells switch to their Markdown source on focus; the caret then goes to one end of that source.
 function focusCell(cell,at='end'){if(!cell)return;cell.focus({preventScroll:true});const range=doc.createRange(),sel=win.getSelection();range.selectNodeContents(cell);range.collapse(at==='start');sel.removeAllRanges();sel.addRange(range);cell.scrollIntoView?.({block:'nearest',inline:'nearest'});}
 const cellAt=(id,row,column)=>blockEl(id)?.querySelector(`[data-cell-row="${row}"][data-cell-column="${column}"]`)||null;
 const orderedSelection=()=>blocks.filter(b=>selected.has(b.id)).map(b=>b.id);
 function paintSelection(){for(const el of list.children)if(el.dataset.blockId)el.classList.toggle('is-selected',selected.has(el.dataset.blockId));list.classList.toggle('has-selection',selected.size>0);}
 function selectBlocks(ids,{anchor=ids[0],focus=ids.at(-1)}={}){
  readAll();closePopup();hideToolbar();selected=new Set(ids.filter(id=>block(id)));if(!selected.size)return;anchorId=anchor;focusId=focus;activeId=focus;
  win.getSelection().removeAllRanges();if(doc.activeElement!==list)list.focus({preventScroll:true});paintSelection();blockEl(focus)?.scrollIntoView?.({block:'nearest'});notifySelection();
 }
 function selectRange(from,to){const a=indexOf(from),z=indexOf(to);if(a<0||z<0)return;const [s,e]=a<z?[a,z]:[z,a];selectBlocks(blocks.slice(s,e+1).map(b=>b.id),{anchor:from,focus:to});}
 function clearSelection(paint=true){if(!selected.size)return;selected=new Set();anchorId=focusId=null;if(paint)paintSelection();}

 // Structural edits
 function convert(b,type,args={}){
  if(TEXT.has(type)){
   const same=b.type===type&&!(type==='callout'&&args.kind&&args.kind!==b.kind)&&!(type==='code'&&args.language!==undefined)&&!(type==='number'&&args.ordinal);
   const target=same&&type!=='paragraph'?'paragraph':type;
   let text=b.type==='table'?[b.headers,...b.rows].map(r=>r.join(' ')).join('\n'):b.type==='toggle'?[b.title,b.text].filter(Boolean).join('\n'):b.text||'';
   if(target==='code'&&b.type!=='code')text=inlineText(text);
   if(b.type==='code'&&target!=='code')text=text.split('\n').map(escapeText).join('\n');
   const next={id:b.id,type:target,text,checked:target==='todo'?!!(args.checked??(b.type==='todo'&&b.checked)):false,language:target==='code'?String(args.language??(b.type==='code'?b.language:'')??''):''};
   if(LIST.has(target))next.indent=LIST.has(b.type)?Number(b.indent)||0:0;
   if(target==='callout')next.kind=CALLOUT_KINDS[args.kind]?args.kind:b.type==='callout'&&CALLOUT_KINDS[b.kind]?b.kind:'note';
   if(target==='number')next.ordinal=args.ordinal||1;
   return next;
  }
  if(type==='toggle'){editingToggles.add(b.id);return {...createToggleBlock({title:String(b.type==='toggle'?b.title:b.text||'').replace(/\n/g,' '),text:b.type==='toggle'?b.text:''}),id:b.id};}
  if(type==='table')return {...createTableBlock(b.text?{headers:[b.text.replace(/\n/g,' '),'Column 2']}:{}),id:b.id};
  if(type==='divider')return {id:b.id,type:'divider',text:'',checked:false,language:''};
  return b;
 }
 function focusAfterConvert(id){
  const b=block(id);if(!b)return;
  if(b.type==='divider'){let next=blocks[indexOf(id)+1];if(!next||!TEXT.has(next.type)){next=freshBlock();blocks.splice(indexOf(id)+1,0,next);commit();render();}focusBlock(next.id,{at:'start'});return;}
  if(b.type==='table'){focusBlock(id,{at:'start'});return;}
  focusBlock(id,{at:'end'});
 }
 function currentId(){const el=selectionEditable();if(el)return el.dataset.blockEdit;const focused=doc.activeElement?.closest?.('[data-block-id]');if(focused&&list.contains(focused))return focused.dataset.blockId;return block(activeId)?activeId:blocks.at(-1).id;}
 function turnInto(type,args={}){
  readAll();if(mode!=='blocks')setMode('blocks');
  const ids=selected.size?orderedSelection():[currentId()];beginChange();
  const ed=!selected.size&&editableOf(ids[0]),caret=ed?selectionOffsets(ed):null;
  if(type==='divider'||type==='table'){
   const b=block(ids.at(-1)),fresh=convert(freshBlock(),type);
   if(b.type==='paragraph'&&!b.text){fresh.id=b.id;blocks[indexOf(b.id)]=fresh;}else blocks.splice(indexOf(b.id)+1,0,fresh);
   clearSelection(false);commit();render();focusAfterConvert(fresh.id);return;
  }
  for(const id of ids){const b=block(id);if(!b||(!TEXT.has(b.type)&&!['toggle','table'].includes(b.type)))continue;blocks[indexOf(id)]=convert(b,type,args);}
  commit();render();
  if(selected.size){paintSelection();return;}
  const b=block(ids[0]);if(b?.type==='toggle'){focusBlock(b.id);return;}
  if(caret?.inside)focusBlock(ids[0],{start:caret.start,end:caret.end});else focusBlock(ids[0]);
 }
 function insertBlocksAfter(id,list_){blocks.splice(indexOf(id)+1,0,...list_);}
 function removeBlocks(ids){
  beginChange();const first=Math.min(...ids.map(indexOf));blocks=blocks.filter(b=>!ids.includes(b.id));if(!blocks.length)blocks=[freshBlock()];
  clearSelection(false);commit();render();const target=blocks[Math.max(0,first-1)];
  if(TEXT.has(target.type))focusBlock(target.id,{at:first===0?'start':'end'});else selectBlocks([target.id]);
 }
 function moveBlocks(ids,delta){
  readAll();const order=ids.map(indexOf).filter(i=>i>=0).sort((a,b)=>a-b);if(!order.length)return;const first=order[0],last=order.at(-1);
  if((delta<0&&first===0)||(delta>0&&last===blocks.length-1))return;
  const ed=!selected.size&&editableOf(ids[0]),caret=ed?selectionOffsets(ed):null;beginChange();
  const moving=order.map(i=>blocks[i]),rest=blocks.filter(b=>!ids.includes(b.id));rest.splice(delta<0?first-1:first+1,0,...moving);blocks=rest;
  commit();render();if(selected.size){paintSelection();blockEl(moving[0].id)?.scrollIntoView?.({block:'nearest'});}else if(caret?.inside)focusBlock(moving[0].id,{start:caret.start,end:caret.end});else focusBlock(moving[0].id);
 }
 function moveBlocksBefore(ids,beforeId){
  if(ids.includes(beforeId))return;readAll();beginChange();const moving=blocks.filter(b=>ids.includes(b.id)),rest=blocks.filter(b=>!ids.includes(b.id));
  const at=beforeId?rest.findIndex(b=>b.id===beforeId):rest.length;rest.splice(at<0?rest.length:at,0,...moving);
  if(rest.map(b=>b.id).join()===blocks.map(b=>b.id).join()){caretBefore=null;return;}
  blocks=rest;commit();render();selectBlocks(moving.map(b=>b.id));
 }
 function indentBlocks(ids,delta){
  readAll();const ed=!selected.size&&editableOf(ids[0]),caret=ed?selectionOffsets(ed):null;beginChange();let changed=false;
  for(const id of ids){const i=indexOf(id),b=blocks[i];if(!b||!LIST.has(b.type))continue;const previous=blocks[i-1],max=previous&&LIST.has(previous.type)?(Number(previous.indent)||0)+1:0,next=Math.max(0,Math.min(max,(Number(b.indent)||0)+delta));if(next!==(Number(b.indent)||0)){b.indent=next;if(b.type==='number')b.ordinal=1;changed=true;}}
  if(!changed){caretBefore=null;return;}
  commit();render();if(selected.size)paintSelection();else if(caret?.inside)focusBlock(ids[0],{start:caret.start,end:caret.end});
 }
 function duplicateBlocks(ids){readAll();beginChange();const last=ids.map(indexOf).sort((a,b)=>a-b).at(-1);const copies=ids.map(id=>{const copy=structuredClone(block(id));copy.id=uid();return copy;});blocks.splice(last+1,0,...copies);commit();render();selectBlocks(copies.map(b=>b.id));}

 // Editing inside one text block
 function insertNodeAtCaret(ed,node){const sel=win.getSelection();if(!sel.rangeCount)return false;const r=sel.getRangeAt(0);if(!ed.contains(r.startContainer))return false;r.deleteContents();r.insertNode(node);const after=doc.createRange();if(node.nodeType===3)after.setStart(node,node.data.length);else after.setStartAfter(node);after.collapse(true);sel.removeAllRanges();sel.addRange(after);return true;}
 function needsSentinel(ed,node){for(let n=node;n&&n!==ed;n=n.parentNode)for(let s=n.nextSibling;s;s=s.nextSibling)if(visibleLength(s))return false;return true;}
 function insertBreak(ed,code=false){
  beginChange();const sel=win.getSelection();if(!sel.rangeCount)return;
  if(code){const text=doc.createTextNode('\n');insertNodeAtCaret(ed,text);if(needsSentinel(ed,text)&&ed.lastChild?.nodeName!=='BR')ed.append(doc.createElement('br'));const r=doc.createRange();r.setStart(text,1);r.collapse(true);sel.removeAllRanges();sel.addRange(r);}
  else{const br=doc.createElement('br');insertNodeAtCaret(ed,br);if(needsSentinel(ed,br))br.after(doc.createElement('br'));const r=doc.createRange();r.setStartAfter(br);r.collapse(true);sel.removeAllRanges();sel.addRange(r);}
  readBlock(ed);updateEmpty(ed);commit();
 }
 function insertPlain(ed,text){beginChange();const node=doc.createTextNode(text);insertNodeAtCaret(ed,node);if(text.endsWith('\n')&&needsSentinel(ed,node)&&ed.lastChild?.nodeName!=='BR')ed.append(doc.createElement('br'));readBlock(ed);updateEmpty(ed);commit();}
 function replaceRange(ed,from,to,markdown,{caretAfter=true}={}){
  const b=readBlock(ed);if(!b)return;const total=visibleLength(ed),before=rangeMarkdown(ed,0,from),after=withoutSentinel(ed,rangeMarkdown(ed,to,total));
  b.text=joinMarkdown(before,markdown,after);commit();renderBlock(b.id);
  const el=editableOf(b.id);if(el){el.focus({preventScroll:true});placeCaret(el,caretAfter?textLength(joinMarkdown(before,markdown)):textLength(before));}
 }
 function onEnter(ed,shift){
  closePopup();const b=readBlock(ed);if(!b)return;
  if(b.type==='code'){insertBreak(ed,true);return;}
  if(shift&&!/^h[1-3]$/.test(b.type)){insertBreak(ed);return;}
  beginChange();const {start,end}=selectionOffsets(ed),total=visibleLength(ed);
  if(!b.text&&LIST.has(b.type)){if(b.indent>0){b.indent--;if(b.type==='number')b.ordinal=1;}else{b.type='paragraph';delete b.indent;b.checked=false;}commit();render();focusBlock(b.id,{at:'start'});return;}
  if(!b.text&&(b.type==='quote'||b.type==='callout')){b.type='paragraph';delete b.kind;commit();renderBlock(b.id);focusBlock(b.id,{at:'start'});return;}
  if(start===0&&end===0&&b.text){const above=freshBlock(LIST.has(b.type)?b.type:'paragraph');if(LIST.has(b.type))above.indent=b.indent||0;blocks.splice(indexOf(b.id),0,above);commit();render();focusBlock(b.id,{at:'start'});return;}
  const before=rangeMarkdown(ed,0,start),after=withoutSentinel(ed,rangeMarkdown(ed,end,total));
  b.text=before;const next=freshBlock(LIST.has(b.type)?b.type:'paragraph',{text:after});if(LIST.has(b.type))next.indent=b.indent||0;
  blocks.splice(indexOf(b.id)+1,0,next);activeId=next.id;commit();render();focusBlock(next.id,{at:'start'});
 }
 function mergeInto(previous,b){
  if(previous.type==='code'){const separator=previous.text&&b.text?'\n':'',caret=previous.text.length+separator.length;previous.text+=separator+inlineText(b.text);return caret;}
  const caret=textLength(previous.text);previous.text=joinMarkdown(previous.text,b.text);return caret;
 }
 function onBackspaceAtStart(ed){
  const b=readBlock(ed);if(!b)return;closePopup();beginChange();const index=indexOf(b.id);
  if(LIST.has(b.type)&&b.indent>0){b.indent--;if(b.type==='number')b.ordinal=1;commit();render();focusBlock(b.id,{at:'start'});return;}
  if(b.type!=='paragraph'&&b.type!=='code'){b.type='paragraph';delete b.indent;delete b.kind;delete b.ordinal;b.checked=false;commit();render();focusBlock(b.id,{at:'start'});return;}
  if(b.type==='code'&&b.text){caretBefore=null;return;}
  const previous=blocks[index-1];if(!previous){if(b.type==='code'){Object.assign(b,{type:'paragraph',language:''});commit();render();focusBlock(b.id,{at:'start'});}else caretBefore=null;return;}
  if(previous.type==='divider'){blocks.splice(index-1,1);commit();render();focusBlock(b.id,{at:'start'});return;}
  if(!TEXT.has(previous.type)){if(!b.text){blocks.splice(index,1);commit();render();}else caretBefore=null;selectBlocks([previous.id]);return;}
  const caret=mergeInto(previous,b);blocks.splice(index,1);activeId=previous.id;commit();render();focusBlock(previous.id,{start:caret});
 }
 function onDeleteAtEnd(ed){
  const b=readBlock(ed);if(!b)return;const next=blocks[indexOf(b.id)+1];if(!next)return;closePopup();beginChange();
  if(next.type==='divider'){blocks.splice(indexOf(next.id),1);commit();render();focusBlock(b.id,{at:'end'});return;}
  if(!TEXT.has(next.type)){caretBefore=null;selectBlocks([next.id]);return;}
  const caret=mergeInto(b,next);blocks.splice(indexOf(next.id),1);commit();render();focusBlock(b.id,{start:caret});
 }
 // A single list item, heading or quote pasted inside a sentence: from plain text its markers are literal text; from
 // HTML, editor Markdown or insertMarkdown (rich) only its inline content is inserted.
 function pasteInto(ed,source,{rich=false}={}){
  const b=readBlock(ed);if(!b)return;closePopup();beginChange();
  const {start,end}=selectionOffsets(ed),total=visibleLength(ed),before=rangeMarkdown(ed,0,start),after=withoutSentinel(ed,rangeMarkdown(ed,end,total));
  const parsed=pasteBlocks(source);if(!parsed.length){caretBefore=null;return;}
  const lone=!before.trim()&&!after.trim();
  if(parsed.length===1&&TEXT.has(parsed[0].type)&&parsed[0].type!=='code'){
   const p=parsed[0];if(lone&&b.type==='paragraph'&&p.type!=='paragraph')Object.assign(b,p,{id:b.id});
   const inserted=p.type==='paragraph'||lone||rich?p.text:escapeText(String(source).trim());
   b.text=joinMarkdown(before,inserted,after);commit();render();focusBlock(b.id,{start:textLength(joinMarkdown(before,inserted))});return;
  }
  let rest=parsed;const first=parsed[0];
  if(first.type==='paragraph'&&TEXT.has(b.type)&&b.type!=='code'){b.text=joinMarkdown(before,first.text);rest=parsed.slice(1);}
  else if(!before.trim()&&b.type==='paragraph'){Object.assign(b,first,{id:b.id});rest=parsed.slice(1);if(!TEXT.has(b.type))editingToggles.delete(b.id);}
  else b.text=before;
  const target=rest.length?rest.at(-1):b,caretAt=TEXT.has(target.type)?textLength(target.text):null;
  if(after){if(TEXT.has(target.type)&&target.type!=='code')target.text=joinMarkdown(target.text,after);else rest.push(freshBlock('paragraph',{text:after}));}
  insertBlocksAfter(b.id,rest);commit();render();
  if(caretAt!==null)focusBlock(target.id,{start:caretAt});else focusBlock(rest.at(-1)?.id||b.id,{at:'end'});
 }
 function replaceSelectedBlocks(source){
  const ids=orderedSelection(),parsed=pasteBlocks(source);if(!ids.length)return;beginChange();
  const at=indexOf(ids[0]);blocks=blocks.filter(b=>!ids.includes(b.id));blocks.splice(at,0,...(parsed.length?parsed:[freshBlock()]));
  clearSelection(false);commit();render();const last=parsed.at(-1)||blocks[at];if(last)focusBlock(last.id,{at:'end'});
 }

 // Runs model for inline formatting: flatten an editable into text runs with marks, change marks over a range,
 // rebuild the DOM in a fixed nesting order (link > strike > bold > italic > code) and read it back as Markdown.
 const ORDER=['link','strike','bold','italic','code'],MARK_ELEMENT={strike:'del',bold:'strong',italic:'em',code:'code'};
 function toRuns(el){
  const runs=[];
  const walk=(node,marks)=>{for(const child of node.childNodes){
   if(child.nodeType===3){const text=child.data.replace(ZWSP,'');if(text)runs.push({text,marks});continue;}
   if(child.nodeType!==1)continue;
   if(child.nodeName==='BR'){runs.push({text:'\n',br:true,marks});continue;}
   const atom=child.getAttribute('contenteditable')==='false'||(child.nodeName==='A'&&(child.dataset.autolink||child.classList.contains('markdown-media-link')));
   if(atom){runs.push({text:child.textContent,atom:child,marks:child.nodeName==='A'?{...marks,link:child}:marks});continue;}
   const mark=nodeMark(child);if(mark){walk(child,{...marks,[mark]:true});continue;}
   if(child.nodeName==='A'){walk(child,{...marks,link:child});continue;}
   walk(child,marks);
  }};
  walk(el,{});return runs;
 }
 function splitRuns(runs,points){const out=[];let pos=0;for(const run of runs){let piece=run;const end=pos+run.text.length;for(const point of points){if(piece.atom||piece.br)break;if(point>pos&&point<end){const cut=point-pos;out.push({...piece,text:piece.text.slice(0,cut)});piece={...piece,text:piece.text.slice(cut)};pos=point;}}out.push(piece);pos=end;}return out;}
 function buildRuns(runs,level,parent){
  if(level>=ORDER.length){for(const run of runs)parent.append(run.atom||(run.br?doc.createElement('br'):doc.createTextNode(run.text)));return;}
  const key=ORDER[level];
  for(let i=0;i<runs.length;){let j=i;const value=runs[i].marks[key];while(j<runs.length&&runs[j].marks[key]===value)j++;const group=runs.slice(i,j);
   if(value&&!(key==='link'&&group.every(r=>r.atom&&r.atom===value))){const el=key==='link'?value.cloneNode(false):doc.createElement(MARK_ELEMENT[key]);buildRuns(group,level+1,el);parent.append(el);}
   else buildRuns(group,level+1,parent);i=j;}
 }
 function marksIn(el,start,end){
  const marks=new Set(),runs=toRuns(el),hit=[];let pos=0;
  for(const run of runs){const len=run.text.length;if(start===end?(pos<start&&start<=pos+len)||(start===0&&pos===0&&len):pos<end&&pos+len>start&&len)hit.push(run);pos+=len;}
  if(hit.length)for(const mark of ['bold','italic','strike','code','link'])if(hit.every(run=>run.marks[mark]))marks.add(mark);
  return marks;
 }
 function applyMark(el,start,end,mark,value){
  const runs=splitRuns(toRuns(el),[start,end]);let pos=0;
  for(const run of runs){const len=run.text.length;if(len&&pos>=start&&pos+len<=end&&!(run.atom&&mark!=='link')){run.marks={...run.marks};if(value)run.marks[mark]=value;else delete run.marks[mark];}pos+=len;}
  el.replaceChildren();buildRuns(runs,0,el);
 }
 function newLink(href){const a=doc.createElement('a');a.className='markdown-link';a.href=href;return a;}
 function format(mark){
  if(!['bold','italic','strike','code','link'].includes(mark))return;
  if(mode==='markdown'){wrapSource(textarea,mark);return;}
  if(mode!=='blocks')setMode('blocks');
  const target=doc.activeElement;
  if(target&&root.contains(target)&&target.matches('[data-toggle-body],[data-toggle-title]')){if(mark==='link')openLinkForm('link');else wrapSource(target,mark);return;}
  if(target&&root.contains(target)&&target.matches('[data-table-cell]')){if(mark==='link')openLinkForm('link');else wrapCell(target,mark);return;}
  const ed=selectionEditable()||restoreEditorSelection();if(!ed){report('Select text to format it.');return;}
  const b=block(ed.dataset.blockEdit);if(!b||b.type==='code')return;
  const {start,end}=selectionOffsets(ed);const active=marksIn(ed,start,end);
  if(mark==='link'){if(active.has('link')){removeLinkAt(ed,start,end);return;}openLinkForm('link');return;}
  if(start===end){report('Select text to format it.');return;}
  beginChange();readBlock(ed);applyMark(ed,start,end,mark,!active.has(mark));readBlock(ed);commit();renderBlock(b.id);
  const el=editableOf(b.id);if(el){el.focus({preventScroll:true});placeCaret(el,start,end);}
  report('');selectionChanged();
 }
 function removeLinkAt(ed,start,end){
  const runs=toRuns(ed);let pos=0,from=start,to=end;
  for(const run of runs){const len=run.text.length;if(run.marks.link&&pos<=start&&start<=pos+len){const link=run.marks.link;let s=pos,e=pos+len,p=0;for(const r of runs){if(r.marks.link===link){s=Math.min(s,p);e=Math.max(e,p+r.text.length);}p+=r.text.length;}from=Math.min(from,s);to=Math.max(to,e);break;}pos+=len;}
  beginChange();readBlock(ed);applyMark(ed,from,to,'link',null);readBlock(ed);commit();const id=ed.dataset.blockEdit;renderBlock(id);const el=editableOf(id);if(el){el.focus({preventScroll:true});placeCaret(el,start,end);}
 }
 function wrapSource(el,mark){
  const start=el.selectionStart,end=el.selectionEnd;if(start===end){if(mark==='link')openLinkForm('link');return;}
  const value=el.value,selectedText=value.slice(start,end);
  const replacement=mark==='code'?codeSpan(selectedText):mark==='link'?`[${selectedText}](<https://>)`:emphasize(selectedText,MARKERS[mark]);
  el.setRangeText(replacement,start,end,'select');el.dispatchEvent(new win.Event('input',{bubbles:true}));
 }
 function sourceSelection(el){const sel=win.getSelection();if(!sel.rangeCount)return null;const range=sel.getRangeAt(0);if(!el.contains(range.startContainer)||!el.contains(range.endContainer))return null;const prefix=range.cloneRange();prefix.selectNodeContents(el);prefix.setEnd(range.startContainer,range.startOffset);return {start:prefix.toString().length,end:prefix.toString().length+range.toString().length};}
 function replaceSource(el,text,{start,end}={}){const value=el.innerText.replace(/\n$/,''),position=start??value.length;el.textContent=value.slice(0,position)+text+value.slice(end??position);const node=el.firstChild;if(node){const range=doc.createRange();range.setStart(node,Math.min(position+text.length,node.length));range.collapse(true);const sel=win.getSelection();sel.removeAllRanges();sel.addRange(range);}beginChange();readCell(el);commit();}
 function wrapCell(el,mark){const position=sourceSelection(el);if(!position||position.start===position.end)return;const selectedText=el.innerText.slice(position.start,position.end);replaceSource(el,mark==='code'?codeSpan(selectedText):emphasize(selectedText,MARKERS[mark]),position);}

 // Live Markdown shortcuts
 function cleanZwsp(ed){
  const sel=win.getSelection(),r=sel.rangeCount?sel.getRangeAt(0):null,walker=doc.createTreeWalker(ed,win.NodeFilter.SHOW_TEXT),fix=[];
  for(let n=walker.nextNode();n;n=walker.nextNode())if(n.data.includes('\u200b')&&n.data.replace(ZWSP,''))fix.push(n);
  for(const n of fix){const caret=r&&r.collapsed&&r.startContainer===n?n.data.slice(0,r.startOffset).replace(ZWSP,'').length:-1;n.data=n.data.replace(ZWSP,'');if(caret>=0){const range=doc.createRange();range.setStart(n,caret);range.collapse(true);sel.removeAllRanges();sel.addRange(range);}}
 }
 function blockShortcut(ed){
  const b=block(ed.dataset.blockEdit);if(!b||b.type==='code')return false;
  const {start,end}=selectionOffsets(ed);if(start!==end)return false;
  const prefix=rangeText(ed,0,start),hit=matchBlockShortcut(prefix);if(!hit)return false;
  if(!(b.type==='paragraph'||(hit.type==='todo'&&b.type==='bullet')))return false;
  beginChange();const rest=withoutSentinel(ed,rangeMarkdown(ed,start,visibleLength(ed)));
  if(hit.type==='divider'){if(rest.trim())return false;const divider=convert(b,'divider');blocks[indexOf(b.id)]=divider;commit();render();focusAfterConvert(divider.id);return true;}
  const next=convert({...b,text:rest},hit.type,{kind:hit.kind,checked:hit.checked,ordinal:hit.ordinal});
  blocks[indexOf(b.id)]=next;commit();render();focusBlock(b.id,{at:'start'});return true;
 }
 function rangeText(el,from,to){if(to<=from)return '';const a=pointAt(el,from),z=pointAt(el,to),range=doc.createRange();range.setStart(a.node,a.offset);range.setEnd(z.node,z.offset);return range.toString().replace(ZWSP,'');}
 function inlineShortcut(ed){
  const b=block(ed.dataset.blockEdit);if(!b||b.type==='code')return false;
  const sel=win.getSelection();if(!sel.rangeCount||!sel.isCollapsed)return false;const r=sel.getRangeAt(0),node=r.startContainer;if(node.nodeType!==3||!ed.contains(node))return false;
  if(node.parentElement.closest('code'))return false;
  const hit=matchInlineShortcut(node.data.slice(0,r.startOffset));if(!hit)return false;
  beginChange();const nodeStart=offsetIn(ed,node,0),from=nodeStart+hit.start;
  node.data=node.data.slice(0,hit.start)+hit.text+node.data.slice(hit.end);
  applyMark(ed,from,from+hit.text.length,hit.mark,hit.mark==='link'?newLink(hit.href):true);
  readBlock(ed);commit();renderBlock(b.id);const el=editableOf(b.id);if(!el)return true;el.focus({preventScroll:true});
  const point=pointAt(el,from+hit.text.length);let mark=point.node.nodeType===3?point.node.parentElement:point.node;
  if(point.node.nodeType===3&&point.offset===point.node.data.length&&mark!==el&&el.contains(mark)){while(mark.parentElement!==el)mark=mark.parentElement;const spacer=doc.createTextNode('\u200b');mark.after(spacer);const range=doc.createRange();range.setStart(spacer,1);range.collapse(true);sel.removeAllRanges();sel.addRange(range);}
  else placeCaret(el,from+hit.text.length);
  return true;
 }
 function trackTriggers(ed,data){
  const b=block(ed.dataset.blockEdit);if(!b||b.type==='code')return;
  const sel=win.getSelection();if(!sel.rangeCount)return;const r=sel.getRangeAt(0),node=r.startContainer,pos=r.startOffset;if(node.nodeType!==3)return;
  if(data==='/'){const before=pos>=2?node.data[pos-2]:(offsetIn(ed,node,0)===0?undefined:'x');if(before===undefined||/\s/.test(before))openSlash(ed,node,pos-1);return;}
  if(data==='['&&searchLinks&&node.data[pos-2]==='['&&node.data[pos-3]!=='['&&node.data[pos-3]!=='\\')openLinkPicker(ed,node,pos-2);
 }

 // Popups: slash menu and [[ picker keep focus in the block (aria-activedescendant); block menus take focus.
 function popupAnchor(){const s=popupState;if(!s)return null;if(s.anchorEl?.isConnected)return s.anchorEl.getBoundingClientRect();return caretRect()||editableOf(s.blockId)?.getBoundingClientRect()||null;}
 function place(el,rect,{gap=6,above=false}={}){
  if(!rect)return;el.style.left='0px';el.style.top='0px';const w=el.offsetWidth,h=el.offsetHeight,vw=win.innerWidth,vh=win.innerHeight;
  let top=above?rect.top-h-gap:rect.bottom+gap;if(!above&&top+h>vh-8&&rect.top-h-gap>=8)top=rect.top-h-gap;if(above&&top<8)top=rect.bottom+gap;
  el.style.left=Math.round(Math.max(8,Math.min(rect.left,vw-w-8)))+'px';el.style.top=Math.round(Math.max(8,Math.min(top,vh-h-8)))+'px';
 }
 function setActiveDescendant(){const s=popupState,ed=s&&s.focus==='editor'&&editableOf(s.blockId);for(const el of list.querySelectorAll(`[aria-activedescendant],[aria-controls="${popup.id}"]`))if(el!==ed){el.removeAttribute('aria-activedescendant');el.removeAttribute('aria-controls');}if(ed){ed.setAttribute('aria-controls',popup.id);if(s.items.length)ed.setAttribute('aria-activedescendant',`${domId}-opt-${s.index}`);else ed.removeAttribute('aria-activedescendant');}}
 function renderPopup(){
  const s=popupState;if(!s)return;const menu=s.role==='menu';let html=s.title?`<div class="block-editor-popup-title">${esc(s.title)}</div>`:'',group=null;
  if(!s.items.length)html+=`<div class="block-editor-popup-empty">${esc(s.loading?'Searching…':s.empty||'No results')}</div>`;
  s.items.forEach((item,i)=>{
   if(item.separator){group=null;html+='<div class="block-editor-popup-separator" role="separator"></div>';}
   else if(item.group&&item.group!==group){group=item.group;html+=`<div class="block-editor-popup-group" role="presentation">${esc(group)}</div>`;}
   html+=`<div class="block-editor-item${i===s.index?' is-active':''}${item.danger?' is-danger':''}${item.current?' is-current':''}" id="${domId}-opt-${i}" role="${menu?'menuitem':'option'}"${menu?'':` aria-selected="${i===s.index}"`} data-popup-index="${i}" tabindex="${i===s.index?0:-1}">${item.iconHtml||(item.icon?icon(item.icon):'')}<span class="block-editor-item-text"><span class="block-editor-item-label">${esc(item.label)}</span>${item.description?`<span class="block-editor-item-desc">${esc(item.description)}</span>`:''}</span>${item.hint?`<kbd class="block-editor-item-hint">${esc(item.hint)}</kbd>`:''}</div>`;
  });
  popup.innerHTML=html;popup.setAttribute('role',menu?'menu':'listbox');popup.setAttribute('aria-label',s.label);popup.classList.toggle('is-wide',!!s.wide);
  setActiveDescendant();const active=popup.querySelector('.is-active');active?.scrollIntoView?.({block:'nearest'});if(s.focus==='popup')(active||popup).focus({preventScroll:true});
 }
 function openPopup(state){
  closeLinkForm();hideToolbar();popupState={index:0,items:[],focus:'editor',role:'listbox',...state};if(state.focus==='popup')popup.tabIndex=-1;
  renderPopup();showFloat(popup);place(popup,popupAnchor());
  if(popupState.focus==='popup')(popup.querySelector('.is-active')||popup).focus({preventScroll:true});
 }
 function closePopup({refocus=false}={}){if(!popupState)return;const s=popupState;popupState=null;clearTimeout(searchTimer);hideFloat(popup);popup.innerHTML='';setActiveDescendant();if(refocus&&s.focus==='popup'&&s.blockId){if(s.restore){clearSelection();restoreCaret(s.restore);}else if(selected.size)list.focus({preventScroll:true});else if(TEXT.has(block(s.blockId)?.type))focusBlock(s.blockId);else selectBlocks([s.blockId]);}}
 function movePopup(delta){const s=popupState;if(!s?.items.length)return;s.index=(s.index+delta+s.items.length)%s.items.length;renderPopup();}
 function choose(index){const s=popupState;const item=s?.items[index];if(!item)return;s.index=index;item.run();}
 function slashItems(query){
  const catalog=[...BLOCK_COMMANDS,...SLASH_EXTRAS.filter(c=>(c[0]!=='note-link'||searchLinks)&&(c[0]!=='ai'||onAskAi))];
  const grouped=!String(query).trim(),found=findBlockCommands(query,catalog);
  const groupOf=id=>GROUPS.findIndex(g=>g[1].includes(id));
  if(grouped)found.sort((a,b)=>groupOf(a[0])-groupOf(b[0])||catalog.indexOf(a)-catalog.indexOf(b));
  return found.map(c=>({id:c[0],label:c[1],description:c[2],icon:c[3],hint:SHORTCUT_HINTS[c[0]],group:grouped?GROUPS[groupOf(c[0])]?.[0]:null,run:()=>runSlash(c[0])}));
 }
 function openSlash(ed,node,offset){openPopup({kind:'slash',label:'Insert block',blockId:ed.dataset.blockEdit,node,offset,marker:'/',query:'',items:slashItems(''),empty:'No matching blocks',wide:true});}
 function openLinkPicker(ed,node,offset){openPopup({kind:'link',label:'Link to a note',title:'Link to a note or item',blockId:ed.dataset.blockEdit,node,offset,marker:'[[',query:null,loading:true,empty:'No matching notes',wide:true});refreshQuery();}
 function searchItems(query){
  const s=popupState,seq=++searchSeq;s.loading=true;clearTimeout(searchTimer);
  searchTimer=win.setTimeout(async()=>{
   let results=[];try{results=await searchLinks(query)||[];}catch{results=[];}if(seq!==searchSeq||popupState!==s)return;
   s.items=results.slice(0,20).map(r=>({id:String(r.id),label:String(r.title||'Untitled'),description:r.subtitle?String(r.subtitle):'',icon:TYPE_ICONS[r.type]||'note',run:()=>insertWikiLink(r.title||'Untitled',r.id)}));
   const typed=query.trim();if(typed&&!s.items.some(i=>i.label.toLowerCase()===typed.toLowerCase()))s.items.push({id:'__title',label:`Link to “${typed}”`,description:'No note has this title yet.',icon:'plus',run:()=>insertWikiLink(typed,null)});
   s.loading=false;s.index=0;renderPopup();place(popup,popupAnchor());
  },query?120:0);
  renderPopup();
 }
 function refreshQuery(){
  const s=popupState;if(!s||s.focus!=='editor')return;const ed=editableOf(s.blockId),sel=win.getSelection();
  if(!ed||!sel.rangeCount||!sel.isCollapsed){closePopup();return;}const r=sel.getRangeAt(0);
  if(r.startContainer!==s.node||!s.node.isConnected||s.node.data.slice(s.offset,s.offset+s.marker.length)!==s.marker||r.startOffset<s.offset+s.marker.length){closePopup();return;}
  const query=s.node.data.slice(s.offset+s.marker.length,r.startOffset).replace(ZWSP,'');if(query===s.query)return;s.query=query;
  if(s.kind==='slash'){if(query.length>40||/\s\s/.test(query)){closePopup();return;}s.items=slashItems(query);s.index=0;if(!s.items.length&&/\s$/.test(query)){closePopup();return;}renderPopup();place(popup,popupAnchor());return;}
  if(query.includes(']')||query.length>120){closePopup();return;}searchItems(query);
 }
 function triggerRange(s){const ed=editableOf(s.blockId);if(!ed||!s.node.isConnected)return null;const sel=win.getSelection(),r=sel.rangeCount?sel.getRangeAt(0):null;const from=offsetIn(ed,s.node,s.offset),to=r&&ed.contains(r.startContainer)?offsetIn(ed,r.startContainer,r.startOffset):from+s.marker.length+(s.query||'').length;return {ed,from,to:Math.max(from,to)};}
 function insertWikiLink(title,id){
  const s=popupState;closePopup();const hit=s&&triggerRange(s);if(!hit)return;beginChange();
  const clean=String(title).replace(/[[\]|\n]/g,' ').replace(/\s+/g,' ').trim().slice(0,200)||'Untitled';
  const target=id!=null&&(clean!==String(title).trim()||/[[\]|\n]/.test(String(title)))?`${id}|${clean}`:clean;
  replaceRange(hit.ed,hit.from,hit.to,`[[${target}]] `);
 }
 function runSlash(id){
  const s=popupState;closePopup();const hit=s&&triggerRange(s);if(!hit)return;const {ed,from,to}=hit;const b=readBlock(ed);if(!b)return;
  beginChange();const total=visibleLength(ed),before=rangeMarkdown(ed,0,from),after=withoutSentinel(ed,rangeMarkdown(ed,to,total));
  b.text=joinMarkdown(before,after);const empty=!b.text.trim(),caret=textLength(before);
  if(id==='ai'||id==='link'||id==='image'||id==='file'||id==='note-link'){
   commit();renderBlock(b.id);const el=editableOf(b.id);if(el){el.focus({preventScroll:true});placeCaret(el,caret);}
   if(id==='ai')askAi('');else if(id==='note-link'&&el){insertPlain(el,'[[');const sel=win.getSelection(),r=sel.getRangeAt(0);if(r.startContainer.nodeType===3)openLinkPicker(el,r.startContainer,r.startOffset-2);}
   else openLinkForm(id);
   return;
  }
  if(empty){const next=convert(b,id);blocks[indexOf(b.id)]=next;commit();render();focusAfterConvert(next.id);return;}
  // The space typed before "/" goes with the command, at the end of the text or before an existing space.
  if(!after.trim()||/^[ \t]/.test(after))b.text=joinMarkdown(before.replace(/[ \t]+$/,''),after);
  const fresh=convert(freshBlock(),id);blocks.splice(indexOf(b.id)+1,0,fresh);commit();render();focusAfterConvert(fresh.id);
 }
 // Opened from text (Mod+/), closing the menu returns the caret; opened on a selection or handle, the selection stays.
 function openActions(id,anchorEl){
  const restore=!selected.has(id)&&selectionEditable()?caretState():null;
  readAll();const b=block(id);if(!b)return;const ids=selected.has(id)?orderedSelection():[id];if(!selected.has(id))selectBlocks([id]);
  // Actions first (they stay visible in short panels), then Turn into, then Delete last after a separator.
  const items=[];
  items.push({id:'copy',label:'Copy as Markdown',icon:'clipboard',group:'Actions',hint:isMac?'⌘C':'Ctrl+C',run:()=>{closePopup({refocus:true});readAll();copyText(serializeNoteBlocks(ids.map(block).filter(Boolean)));}});
  items.push({id:'duplicate',label:'Duplicate',icon:'copy',group:'Actions',hint:isMac?'⌘D':'Ctrl+D',run:()=>{closePopup({refocus:true});duplicateBlocks(ids);}});
  items.push({id:'up',label:'Move up',icon:'up',group:'Actions',hint:isMac?'⌥⇧↑':'Alt+Shift+↑',run:()=>{closePopup({refocus:true});moveBlocks(ids,-1);}});
  items.push({id:'down',label:'Move down',icon:'down',group:'Actions',hint:isMac?'⌥⇧↓':'Alt+Shift+↓',run:()=>{closePopup({refocus:true});moveBlocks(ids,1);}});
  if(TEXT.has(b.type)||b.type==='toggle'){for(const type of ['paragraph','h1','h2','h3','bullet','number','todo','quote','callout','code','toggle']){const c=BLOCK_COMMANDS.find(x=>x[0]===type);items.push({id:'turn-'+type,label:c[1],icon:c[3],group:'Turn into',current:b.type===type,run:()=>{closePopup();turnInto(type);if(ids.length===1&&block(id)){clearSelection();focusBlock(id);}}});}}
  items.push({id:'delete',label:ids.length>1?'Delete blocks':'Delete',icon:'trash',separator:true,danger:true,hint:'Del',run:()=>{closePopup();removeBlocks(ids);}});
  openPopup({kind:'actions',label:'Block options',role:'menu',focus:'popup',blockId:id,anchorEl,items,restore});
 }
 function copyText(value){const done=()=>report(''),fail=()=>report('Copy did not work here. Select the blocks and press '+(isMac?'⌘C':'Ctrl+C')+'.');try{win.navigator.clipboard.writeText(value).then(done,fail);}catch{fail();}}
 function openKinds(id,anchorEl){
  const b=block(id);if(!b)return;
  openPopup({kind:'kinds',label:'Callout type',role:'menu',focus:'popup',blockId:id,anchorEl,index:Math.max(0,Object.keys(CALLOUT_KINDS).indexOf(b.kind)),items:Object.entries(CALLOUT_KINDS).map(([kind,entry])=>({id:kind,label:entry.label,iconHtml:calloutIcon(kind),current:b.kind===kind,run:()=>{closePopup();readAll();beginChange();b.kind=kind;commit();renderBlock(id);focusBlock(id);}}))});
 }

 // Selection toolbar and link form
 function hideToolbar(){if(!toolbar.hidden)hideFloat(toolbar);}
 function updateToolbar(ed,marks){
  const sel=win.getSelection();
  if(!ed||!sel.rangeCount||sel.isCollapsed||!sel.toString().trim()||popupState||!linkForm.hidden||block(ed.dataset.blockEdit)?.type==='code'||!ed.contains(sel.getRangeAt(0).endContainer)){hideToolbar();return;}
  for(const button of toolbar.querySelectorAll('[data-format]'))button.setAttribute('aria-pressed',String(marks.has(button.dataset.format)));
  showFloat(toolbar);place(toolbar,sel.getRangeAt(0).getBoundingClientRect(),{above:true,gap:8});
 }
 function openLinkForm(kind='link'){
  hideToolbar();closePopup();const active=doc.activeElement;const ed=selectionEditable();
  linkTarget={kind};
  if(active&&root.contains(active)&&active.matches('[data-table-cell]'))linkTarget={kind,cell:active,position:sourceSelection(active)};
  else if(active&&root.contains(active)&&active.matches('[data-toggle-body]'))linkTarget={kind,body:active,position:{start:active.selectionStart,end:active.selectionEnd}};
  else if(ed){const {start,end}=selectionOffsets(ed);linkTarget={kind,blockId:ed.dataset.blockEdit,start,end};}
  else{const restored=restoreEditorSelection();if(restored){const {start,end}=selectionOffsets(restored);linkTarget={kind,blockId:restored.dataset.blockEdit,start,end};}}
  if(!linkTarget.blockId&&!linkTarget.cell&&!linkTarget.body){const b=blocks.at(-1);linkTarget={kind,blockId:b.id,start:TEXT.has(b.type)?textLength(b.text):0,end:TEXT.has(b.type)?textLength(b.text):0};}
  const el=linkTarget.blockId&&editableOf(linkTarget.blockId),hasText=linkTarget.start!==linkTarget.end;
  let existing='';if(el&&kind==='link'){const runs=toRuns(el);let pos=0;for(const run of runs){if(run.marks.link&&pos<=linkTarget.start&&linkTarget.start<pos+Math.max(1,run.text.length)){existing=run.marks.link.getAttribute('href')||'';break;}pos+=run.text.length;}}
  const label=linkForm.querySelector('[data-link-label]'),url=linkForm.querySelector('[data-link-url]');
  linkForm.querySelector('[data-link-label-field]').hidden=!!(kind==='link'&&el&&hasText);
  label.value=el&&hasText?rangeText(el,linkTarget.start,linkTarget.end):'';url.value=existing;
  linkForm.setAttribute('aria-label',kind==='image'?'Image link':kind==='file'?'File link':'Link');
  linkForm.querySelector('[data-editor-action="link-remove"]').hidden=!existing;showLinkError('');
  const rect=(()=>{const sel=win.getSelection();if(sel.rangeCount&&el&&el.contains(sel.anchorNode)){const r=sel.getRangeAt(0).getBoundingClientRect();if(r.width||r.height)return r;}return caretRect()||(el||linkTarget.cell||linkTarget.body||list).getBoundingClientRect();})();
  showFloat(linkForm);place(linkForm,rect);(label.closest('[hidden]')||label.value?url:label).focus();
 }
 function showLinkError(message){const el=linkForm.querySelector('.block-editor-linkform-error');el.textContent=message;el.hidden=!message;}
 function closeLinkForm(refocus=false){if(linkForm.hidden)return;hideFloat(linkForm);const target=linkTarget;linkTarget=null;if(refocus&&target){if(target.cell)target.cell.focus();else if(target.body)target.body.focus();else if(target.blockId)focusBlock(target.blockId,{start:target.start,end:target.end});}}
 function submitLinkForm(){
  const target=linkTarget;if(!target)return;const href=safeMarkdownUrl(linkForm.querySelector('[data-link-url]').value);
  if(!href){showLinkError('Use an https://, http:// or mailto: address, or a #heading anchor.');linkForm.querySelector('[data-link-url]').focus();return;}
  const typed=linkForm.querySelector('[data-link-label]').value.trim(),kind=target.kind;
  hideFloat(linkForm);linkTarget=null;
  const markdown=label=>linkMarkdown(escapeText(kind==='file'?'File: '+label:label),href,kind==='image');
  if(target.cell){target.cell.focus();replaceSource(target.cell,markdown(typed||href),target.position||{});return;}
  if(target.body){const el=target.body;el.focus();el.setRangeText(markdown(typed||href),target.position.start,target.position.end,'end');el.dispatchEvent(new win.Event('input',{bubbles:true}));return;}
  const ed=editableOf(target.blockId);if(!ed){report('The block for this link is gone.');return;}
  beginChange();ed.focus({preventScroll:true});
  if(kind==='link'&&target.start!==target.end){readBlock(ed);applyMark(ed,target.start,target.end,'link',newLink(href));readBlock(ed);commit();renderBlock(target.blockId);const el=editableOf(target.blockId);if(el){el.focus({preventScroll:true});placeCaret(el,target.end);}return;}
  replaceRange(ed,target.start,target.end,markdown(typed||href));
 }
 function linkFormKey(e){if(e.key==='Enter'){e.preventDefault();e.stopPropagation();submitLinkForm();}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeLinkForm(true);}}
 function removeLink(){const target=linkTarget;closeLinkForm();if(!target?.blockId)return;const ed=editableOf(target.blockId);if(ed)removeLinkAt(ed,target.start,target.end);}
 function restoreEditorSelection(){const current=selectionEditable();if(current)return current;if(!lastRange)return null;const ed=editableOf(lastRange.id);if(!ed)return null;ed.focus({preventScroll:true});placeCaret(ed,Math.min(lastRange.start,visibleLength(ed)),Math.min(lastRange.end,visibleLength(ed)));return ed;}
 function askAi(text){if(!onAskAi)return;readAll();const markdown=serializeNoteBlocks(blocks),selection=text??win.getSelection().toString();hideToolbar();onAskAi({text:selection,markdown,selection,draft:markdown});}
 function notifySelection(text='',marks=new Set()){if(onSelectionChange)try{onSelectionChange({text,marks,block:block(activeId)?.type||'paragraph'});}catch(error){console.error(error);}}
 function selectionChanged(){
  if(mode!=='blocks'||!root.isConnected)return;const ed=selectionEditable();
  if(!ed){hideToolbar();if(popupState?.focus==='editor')closePopup();return;}
  const id=ed.dataset.blockEdit,{start,end}=selectionOffsets(ed);activeId=id;lastRange={id,start,end};
  if(popupState?.focus==='editor')refreshQuery();
  const marks=block(id)?.type==='code'?new Set():marksIn(ed,start,end);updateToolbar(ed,marks);notifySelection(win.getSelection().toString(),marks);
 }

 // Modes
 function autosize(){textarea.style.height='auto';textarea.style.height=Math.max(textarea.scrollHeight,160)+'px';}
 function renderPreview(){const value=textarea.value;preview.innerHTML=value.trim()?renderMarkdown(value,{interactiveTasks:true,resolveLink}):'<p class="block-editor-empty">Nothing to preview yet.</p>';}
 function setMode(next){
  if(!MODES.some(m=>m[0]===next))return;if(mode==='blocks'){readAll();if(serializeNoteBlocks(blocks)!==lastSnapshot)commit({coalesce:true});}
  closePopup();hideToolbar();closeLinkForm();clearSelection(false);
  mode=next;root.dataset.mode=mode;list.hidden=mode!=='blocks';sourceWrap.hidden=mode!=='markdown';preview.hidden=mode!=='preview';
  if(mode==='blocks')render();if(mode==='preview')renderPreview();if(mode==='markdown')autosize();
  for(const button of root.querySelectorAll('[data-editor-mode]'))button.setAttribute('aria-pressed',String(button.dataset.editorMode===mode));
 }
 // After a pointer switches modes, focus follows into the new view (without scrolling) so shortcuts keep working.
 function focusContent(){if(mode==='markdown')textarea.focus({preventScroll:true});else if(mode==='preview')preview.focus({preventScroll:true});else if(!restoreEditorSelection())list.focus({preventScroll:true});}
 // The textarea changed outside the block view: typing in Markdown mode coalesces into one undo step per pause;
 // a preview checkbox, insertMarkdown or a host write is a step of its own. `notify` is for writes made here
 // (not by typing), which still owe the host the bubbling "input" event every edit promises.
 function external({coalesce=false,notify=false}={}){
  if(setting)return;const value=textarea.value;if(value===lastSnapshot)return;
  const now=Date.now(),merge=coalesce&&lastEdit.source==='markdown'&&lastEdit.coalesce&&now-lastEdit.at<COALESCE_PAUSE&&now-lastEdit.since<COALESCE_SPAN&&undoStack.length;
  if(!merge){undoStack.push({md:lastSnapshot,caret:null});if(undoStack.length>200)undoStack.shift();}
  redoStack=[];lastSnapshot=value;lastEdit={at:now,since:merge?lastEdit.since:now,id:null,coalesce,source:'markdown'};blocks=reparse(value);
  if(mode==='blocks'){closePopup();clearSelection(false);render();}else if(mode==='preview')renderPreview();else autosize();
  if(notify){setting=true;try{textarea.dispatchEvent(new win.Event('input',{bubbles:true}));}finally{setting=false;}}
  onChange(value);
 }
 function setMarkdown(value,{emit:shouldEmit=false}={}){
  const md=String(value??'');closePopup();hideToolbar();closeLinkForm();clearSelection(false);editingToggles.clear();report('');
  if(shouldEmit){readAll();caretBefore=null;undoStack.push({md:lastSnapshot,caret:caretState()});redoStack=[];blocks=reparse(md);lastSnapshot=md;lastEdit={at:0,since:0,id:null,coalesce:false,source:''};emit(md);}
  else{blocks=reparse(md);lastSnapshot=md;undoStack=[];redoStack=[];lastEdit={at:0,since:0,id:null,coalesce:false,source:''};textarea.value=md;}
  activeId=blocks[0].id;lastRange=null;
  if(mode==='blocks')render();else if(mode==='preview')renderPreview();else autosize();
 }
 function insertMarkdown(value,{at='cursor'}={}){
  const source=String(value??'').replace(/\r\n?/g,'\n');if(!source.trim())return;
  if(mode!=='blocks'){
   const current=textarea.value,end=at==='end'||mode==='preview';let start=end?current.length:textarea.selectionStart,stop=end?current.length:at==='replace-selection'?textarea.selectionEnd:textarea.selectionStart;
   const insert=end&&current&&!current.endsWith('\n')?'\n'+source:source;textarea.value=current.slice(0,start)+insert+current.slice(stop);external({notify:true});if(mode==='markdown')textarea.setSelectionRange(start+insert.length,start+insert.length);return;
  }
  readAll();
  if(at==='replace-selection'&&selected.size){replaceSelectedBlocks(source);return;}
  if(at==='end'){beginChange();const parsed=pasteBlocks(source),last=blocks.at(-1);if(last&&last.type==='paragraph'&&!last.text&&blocks.length>1)blocks.pop();else if(last&&docEmpty())blocks=[];blocks.push(...parsed);if(!blocks.length)blocks=[freshBlock()];clearSelection(false);commit();render();focusBlock(blocks.at(-1).id,{at:'end'});return;}
  clearSelection();const ed=restoreEditorSelection();if(!ed){insertMarkdown(source,{at:'end'});return;}
  if(at==='cursor'){const sel=win.getSelection();if(sel.rangeCount&&!sel.isCollapsed)sel.collapseToEnd();}
  if(block(ed.dataset.blockEdit)?.type==='code'){insertPlain(ed,source);return;}
  pasteInto(ed,source,{rich:true});
 }
 function getSelectionInfo(){
  if(mode==='markdown'){const start=textarea.selectionStart,end=textarea.selectionEnd;return {text:textarea.value.slice(start,end),start,end};}
  if(mode==='preview'){const sel=win.getSelection();return {text:sel.rangeCount&&preview.contains(sel.anchorNode)?sel.toString():'',start:0,end:0};}
  readAll();const parts=serializeBlockParts(blocks),starts=[];let pos=0;for(const part of parts){starts.push(pos);pos+=part.length+1;}
  const markdown=parts.join('\n'),skipGap=i=>parts[i].startsWith('\n')?1:0;
  if(selected.size){const ids=orderedSelection(),i=indexOf(ids[0]),j=indexOf(ids.at(-1)),start=starts[i]+skipGap(i),end=starts[j]+parts[j].length;return {text:markdown.slice(start,end),start,end};}
  const ed=selectionEditable()||(lastRange&&editableOf(lastRange.id));if(!ed)return {text:'',start:0,end:0};
  const i=indexOf(ed.dataset.blockEdit),offsets=selectionOffsets(ed).inside?selectionOffsets(ed):{start:lastRange?.start||0,end:lastRange?.end||0};
  const part=parts[i].slice(skipGap(i)),lead=(/^(?:[ \t]*(?:[-*] \[[ xX]\] |[-*] |\d+\. )|#{1,3} |> \[![A-Za-z]+\]\n> |> |`{3,}[^\n]*\n)/.exec(part)||[''])[0].length;
  const start=starts[i]+skipGap(i)+lead+(block(ed.dataset.blockEdit).type==='code'?rangeText(ed,0,offsets.start).length:rangeMarkdown(ed,0,offsets.start).length);
  const inner=block(ed.dataset.blockEdit).type==='code'?rangeText(ed,offsets.start,offsets.end):rangeMarkdown(ed,offsets.start,offsets.end);
  return {text:rangeText(ed,offsets.start,offsets.end),start,end:start+inner.length};
 }

 // Events
 on(list,'beforeinput',e=>{
  if(mode!=='blocks')return;beginChange();const ed=e.target.closest?.('[data-block-edit]');if(!ed)return;
  if(e.inputType==='historyUndo'){e.preventDefault();undo();return;}
  if(e.inputType==='historyRedo'){e.preventDefault();redo();return;}
  if(e.inputType==='insertParagraph'){e.preventDefault();onEnter(ed,false);return;}
  if(e.inputType==='insertLineBreak'){e.preventDefault();onEnter(ed,true);return;}
  if(/^format/.test(e.inputType))e.preventDefault();
 });
 on(list,'compositionstart',()=>{composing=true;});
 on(list,'compositionend',e=>{composing=false;const ed=e.target.closest?.('[data-block-edit]');if(ed){readBlock(ed);commit({coalesce:true});}});
 on(list,'input',e=>{
  if(mode!=='blocks')return;const t=e.target;
  const ed=t.closest?.('[data-block-edit]');
  if(ed){
   activeId=ed.dataset.blockEdit;if(composing||e.isComposing){readBlock(ed);commit({coalesce:true});return;}
   cleanZwsp(ed);readBlock(ed);updateEmpty(ed);commit({coalesce:true});
   if(e.inputType==='insertText'&&e.data){if(blockShortcut(ed)||inlineShortcut(ed))return;trackTriggers(ed,e.data.slice(-1));}
   refreshQuery();return;
  }
  if(t.matches?.('[data-table-cell]')){readCell(t);commit({coalesce:true});return;}
  if(t.matches?.('[data-toggle-title]')){const b=block(t.dataset.toggleTitle);if(b){b.title=t.value.replace(/\r?\n/g,' ');activeId=b.id;commit({coalesce:true});}return;}
  if(t.matches?.('[data-toggle-body]')){const b=block(t.dataset.toggleBody);if(b){b.text=t.value;activeId=b.id;commit({coalesce:true});}return;}
  if(t.matches?.('[data-code-lang]')){const b=block(t.dataset.codeLang);if(b){b.language=t.value.trim();activeId=b.id;commit({coalesce:true});}}
 });
 on(list,'focusin',e=>{
  const el=e.target,id=el.dataset?.blockEdit||el.dataset?.toggleTitle||el.dataset?.toggleBody||el.dataset?.tableCell||el.dataset?.codeLang;if(id){activeId=id;if(selected.size)clearSelection();}
  if(el.dataset?.tableCell&&el.dataset.sourceEditing!=='true'){const b=block(el.dataset.tableCell),row=Number(el.dataset.cellRow),column=Number(el.dataset.cellColumn);el.textContent=(row<0?b.headers:b.rows[row])?.[column]||'';el.dataset.sourceEditing='true';baselines.set(el,{html:el.innerHTML});}
 });
 on(list,'focusout',e=>{const el=e.target;if(el.dataset?.tableCell&&el.dataset.sourceEditing==='true'){readCell(el);commit({coalesce:true});const b=block(el.dataset.tableCell),row=Number(el.dataset.cellRow),column=Number(el.dataset.cellColumn);if(b){el.innerHTML=renderTableCell((row<0?b.headers:b.rows[row])?.[column]||'',{resolveLink});delete el.dataset.sourceEditing;}}});
 on(list,'change',e=>{const id=e.target.dataset?.blockCheck;if(!id)return;const b=block(id);if(!b)return;readAll();beginChange();b.checked=e.target.checked;activeId=id;commit();blockEl(id)?.classList.toggle('is-checked',b.checked);});
 on(preview,'change',e=>{const input=e.target.closest?.('[data-task-index]');if(!input)return;const value=toggleTask(textarea.value,Number(input.dataset.taskIndex),input.checked);if(value===textarea.value)return;textarea.value=value;external({notify:true});});
 on(root,'pointerdown',e=>{if(e.target.closest('button,[data-popup-index]')&&!e.target.closest('.block-editor-linkform,[data-block-drag]'))e.preventDefault();});
 on(list,'pointerdown',e=>{
  if(e.button!==0||mode!=='blocks')return;const t=e.target,blockElm=t.closest('[data-block-id]');if(t.closest('.block-gutter,input,textarea,button'))return;
  if(e.shiftKey&&blockElm){const from=selected.size?anchorId:activeId;if(from&&block(from)&&from!==blockElm.dataset.blockId){e.preventDefault();selectRange(from,blockElm.dataset.blockId);return;}}
  if(blockElm?.dataset.type==='divider'){e.preventDefault();selectBlocks([blockElm.dataset.blockId]);return;}
  if(selected.size)clearSelection();
  dragSelect=blockElm&&t.closest('[data-block-edit]')?{origin:blockElm.dataset.blockId,active:false}:null;
 });
 on(doc,'pointermove',e=>{
  if(!dragSelect||!(e.buttons&1))return;const hit=doc.elementFromPoint(e.clientX,e.clientY)?.closest?.('[data-block-id]');const over=hit&&list.contains(hit)?hit.dataset.blockId:null;
  if(over&&over!==dragSelect.origin){dragSelect.active=true;selectRange(dragSelect.origin,over);}else if(over===dragSelect.origin&&dragSelect.active){dragSelect.active=false;clearSelection();focusBlock(over);}
 });
 on(doc,'pointerup',()=>{dragSelect=null;});
 on(doc,'pointerdown',e=>{if(popupState&&!popup.contains(e.target)&&!e.target.closest?.('[data-block-drag],[data-callout-kind]'))closePopup();if(!linkForm.hidden&&!linkForm.contains(e.target))closeLinkForm();},true);
 on(root,'click',e=>{
  const t=e.target;
  const modeButton=t.closest('[data-editor-mode]');if(modeButton){const next=modeButton.dataset.editorMode,changed=next!==mode;setMode(next);if(changed&&e.detail>0)focusContent();return;}
  const formatButton=t.closest('[data-format]');if(formatButton){format(formatButton.dataset.format);return;}
  const item=t.closest('[data-popup-index]');if(item&&popup.contains(item)){choose(Number(item.dataset.popupIndex));return;}
  const action=t.closest('[data-editor-action]')?.dataset.editorAction;
  if(action==='ask-ai'){askAi();return;}if(action==='link-save'){submitLinkForm();return;}if(action==='link-cancel'){closeLinkForm(true);return;}if(action==='link-remove'){removeLink();return;}
  const add=t.closest('[data-block-add]');if(add){addBelow(add.dataset.blockAdd);return;}
  const handle=t.closest('[data-block-drag]');if(handle){if(popupState?.kind==='actions'&&popupState.blockId===handle.dataset.blockDrag){closePopup();return;}openActions(handle.dataset.blockDrag,handle);return;}
  const kind=t.closest('[data-callout-kind]');if(kind){openKinds(kind.dataset.calloutKind,kind);return;}
  const tableButton=t.closest('[data-table-action]');if(tableButton){tableAction(tableButton);return;}
  const opener=t.closest('[data-toggle-open]');if(opener){const id=opener.dataset.toggleOpen,b=block(id);if(b){readAll();beginChange();b.open=!b.open;if(!b.open)editingToggles.delete(id);activeId=id;commit();renderBlock(id);blockEl(id)?.querySelector('[data-toggle-open]')?.focus({preventScroll:true});}return;}
  const toggleButton=t.closest('[data-toggle-edit]');if(toggleButton){readAll();const id=toggleButton.dataset.toggleEdit;if(editingToggles.has(id))editingToggles.delete(id);else editingToggles.add(id);renderBlock(id);blockEl(id)?.querySelector(editingToggles.has(id)?'[data-toggle-body]':'[data-toggle-edit]')?.focus();return;}
  const chip=t.closest('a.note-link[data-id]');if(chip){e.preventDefault();onOpenLink(chip.dataset.id);return;}
  if(t.closest('.note-link')){e.preventDefault();return;}
  const link=t.closest('a[href]');if(link&&list.contains(link)){e.preventDefault();if(e.metaKey||e.ctrlKey)win.open(link.href,'_blank','noopener,noreferrer');return;}
  if(t===list&&mode==='blocks'&&!selected.size){const last=blocks.at(-1),box=blockEl(last.id)?.getBoundingClientRect();if(box&&e.clientY>box.bottom){if(last.type==='paragraph'&&!last.text)focusBlock(last.id);else{readAll();beginChange();const fresh=freshBlock();blocks.push(fresh);commit();render();focusBlock(fresh.id);}}}
 });
 on(popup,'mousemove',e=>{const item=e.target.closest('[data-popup-index]');if(item&&popupState&&Number(item.dataset.popupIndex)!==popupState.index){popupState.index=Number(item.dataset.popupIndex);for(const el of popup.querySelectorAll('[data-popup-index]')){el.classList.toggle('is-active',el===item);el.tabIndex=el===item?0:-1;if(el.hasAttribute('aria-selected'))el.setAttribute('aria-selected',String(el===item));}setActiveDescendant();}});
 function addBelow(id){readAll();beginChange();const fresh=freshBlock();blocks.splice(indexOf(id)+1,0,fresh);commit();render();focusBlock(fresh.id,{at:'start'});const ed=editableOf(fresh.id);if(!ed)return;insertPlain(ed,'/');const r=win.getSelection().getRangeAt(0);if(r.startContainer.nodeType===3)openSlash(ed,r.startContainer,r.startOffset-1);}
 function tableAction(button){
  readAll();const b=block(button.dataset.tableId);if(!b)return;const active=doc.activeElement?.dataset?.tableCell===b.id?doc.activeElement:null;
  const cell=active?{row:Number(active.dataset.cellRow),column:Number(active.dataset.cellColumn)}:{row:Math.max(0,b.rows.length-1),column:tableWidth(b)-1};let next,position={...cell};
  try{
   const kind=button.dataset.tableAction;
   if(kind==='add-row'){const index=Math.min(b.rows.length,Math.max(0,cell.row+1));next=insertTableRow(b,index);position.row=index;}
   if(kind==='remove-row'){if(!b.rows.length)return;const index=Math.max(0,Math.min(b.rows.length-1,cell.row));next=removeTableRow(b,index);position.row=Math.min(index,next.rows.length-1);}
   if(kind==='add-column'){const index=cell.column+1;next=insertTableColumn(b,index);position.column=index;}
   if(kind==='remove-column'){next=removeTableColumn(b,cell.column);position.column=Math.min(cell.column,tableWidth(next)-1);}
   if(next){beginChange();blocks[indexOf(b.id)]=next;activeId=b.id;report('');commit();render();focusCell(cellAt(b.id,position.row,position.column));}
  }catch(cause){report(cause.message);}
 }

 // Keyboard
 const modDown=e=>isMac?e.metaKey:e.ctrlKey;
 const ed0=t=>t.closest?.('[data-block-edit]');
 // The block menu from the keyboard: the Menu key, Shift+F10 or Mod+/.
 const actionsKey=e=>e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')||(modDown(e)&&!e.altKey&&e.key==='/');
 on(root,'keydown',e=>{
  if(e.isComposing||e.keyCode===229)return;const t=e.target;
  if(linkForm.contains(t)){linkFormKey(e);return;}
  if(popupState?.focus==='popup'&&popup.contains(t)){popupKey(e);return;}
  const mod=modDown(e),key=e.key.toLowerCase();
  if(mod&&!e.altKey&&(key==='z'||(key==='y'&&!isMac))){if(mode==='markdown'&&t===textarea)return;e.preventDefault();e.stopPropagation();if(key==='y'||e.shiftKey)redo();else undo();return;}
  if(mode!=='blocks')return;
  if(e.key==='Escape'&&popupState&&!popup.contains(t)&&!(ed0(t)&&popupState.focus==='editor')){e.preventDefault();e.stopPropagation();closePopup();return;}
  if(t===list){selectionKey(e);return;}
  const ed=t.closest?.('[data-block-edit]');
  if(ed&&popupState?.focus==='editor'&&comboKey(e))return;
  if(mod&&!e.altKey&&(['b','i','e','k'].includes(key)||(key==='x'&&e.shiftKey))&&(ed||t.matches('[data-table-cell],[data-toggle-body],[data-toggle-title]'))){e.preventDefault();e.stopPropagation();format({b:'bold',i:'italic',e:'code',k:'link',x:'strike'}[key]);return;}
  if(mod&&!e.altKey&&key==='a'&&ed){const {start,end}=selectionOffsets(ed);if((start===0&&end>=contentLength(ed))||!contentLength(ed)){e.preventDefault();selectBlocks(blocks.map(b=>b.id));}return;}
  if(actionsKey(e)){const id=t.closest?.('[data-block-id]')?.dataset.blockId;if(id){e.preventDefault();e.stopPropagation();openActions(id,blockEl(id)?.querySelector('[data-block-drag]'));}return;}
  if(mod&&!e.altKey&&key==='d'&&!e.shiftKey){const id=t.closest?.('[data-block-id]')?.dataset.blockId;if(id){e.preventDefault();e.stopPropagation();duplicateBlocks([id]);}return;}
  if(e.altKey&&e.shiftKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){const id=t.closest?.('[data-block-id]')?.dataset.blockId;if(id){e.preventDefault();e.stopPropagation();moveBlocks([id],e.key==='ArrowUp'?-1:1);}return;}
  if(e.key==='Escape'){const id=t.closest?.('[data-block-id]')?.dataset.blockId;if(id){e.preventDefault();e.stopPropagation();readAll();selectBlocks([id]);}return;}
  if(t.matches('[data-table-cell]')){tableKey(e,t);return;}
  if(t.matches('[data-toggle-title]')){toggleTitleKey(e,t);return;}
  if(t.matches('[data-toggle-body]')){toggleBodyKey(e,t);return;}
  if(t.matches('[data-code-lang]')){if(e.key==='Enter'||e.key==='ArrowDown'){e.preventDefault();focusBlock(t.dataset.codeLang,{at:'start'});}return;}
  if(ed)textKey(e,ed);
 });
 function comboKey(e){
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();movePopup(e.key==='ArrowDown'?1:-1);return true;}
  if((e.key==='Enter'||e.key==='Tab')&&!e.shiftKey){if(!popupState.items.length){if(e.key==='Enter'){closePopup();return false;}return false;}e.preventDefault();e.stopPropagation();choose(popupState.index);return true;}
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePopup();return true;}
  return false;
 }
 function popupKey(e){
  const s=popupState;if(!s)return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();movePopup(e.key==='ArrowDown'?1:-1);}
  else if(e.key==='Home'||e.key==='End'){e.preventDefault();s.index=e.key==='Home'?0:s.items.length-1;renderPopup();}
  else if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(s.index);}
  else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePopup({refocus:true});}
  else if(e.key==='Tab'){e.preventDefault();closePopup({refocus:true});}
  else if(e.key.length===1&&!e.metaKey&&!e.ctrlKey){const i=s.items.findIndex((item,k)=>k>s.index&&item.label.toLowerCase().startsWith(e.key.toLowerCase()));const j=i>=0?i:s.items.findIndex(item=>item.label.toLowerCase().startsWith(e.key.toLowerCase()));if(j>=0){s.index=j;renderPopup();}}
 }
 function selectionKey(e){
  const ids=orderedSelection(),mod=modDown(e),key=e.key;
  if(!ids.length){if(key==='Enter'&&block(activeId)){e.preventDefault();focusBlock(activeId);}else if(key.length===1&&!mod)e.preventDefault();return;}
  if(key==='Escape'){e.preventDefault();e.stopPropagation();clearSelection();return;}
  if(key==='ArrowUp'||key==='ArrowDown'){
   e.preventDefault();const delta=key==='ArrowUp'?-1:1;
   if(e.altKey&&e.shiftKey){moveBlocks(ids,delta);return;}
   if(e.shiftKey){const next=blocks[indexOf(focusId)+delta];if(next)selectRange(anchorId,next.id);return;}
   const edge=delta<0?indexOf(ids[0]):indexOf(ids.at(-1)),next=blocks[edge+delta]||blocks[edge];selectBlocks([next.id]);return;
  }
  if(key==='Enter'){e.preventDefault();const id=focusId||ids[0];clearSelection();focusBlock(id);return;}
  if(key==='Backspace'||key==='Delete'){e.preventDefault();e.stopPropagation();removeBlocks(ids);return;}
  if(key==='Tab'){e.preventDefault();indentBlocks(ids,e.shiftKey?-1:1);return;}
  if(mod&&key.toLowerCase()==='a'){e.preventDefault();selectBlocks(blocks.map(b=>b.id));return;}
  if(mod&&key.toLowerCase()==='d'){e.preventDefault();e.stopPropagation();duplicateBlocks(ids);return;}
  if(actionsKey(e)){e.preventDefault();e.stopPropagation();const id=focusId||ids[0];openActions(id,blockEl(id)?.querySelector('[data-block-drag]'));return;}
  if(key.length===1&&!mod)e.preventDefault();
 }
 // Caret moves skip dividers (they are removed with Backspace/Delete beside them, or selected with Escape and Shift+arrows).
 const neighbor=(index,step)=>{for(let i=index+step;i>=0&&i<blocks.length;i+=step)if(blocks[i].type!=='divider')return blocks[i];return blocks[index+step]||null;};
 function textKey(e,ed){
  const b=block(ed.dataset.blockEdit);if(!b)return;const mod=modDown(e),key=e.key,sel=win.getSelection(),collapsed=sel.isCollapsed;
  if(key==='Enter'&&!e.altKey&&!mod){e.preventDefault();onEnter(ed,e.shiftKey);return;}
  // Shift+Tab on a top-level item falls through to the browser, which moves focus to that row's checkbox.
  if(key==='Tab'&&!mod&&!e.altKey){if(b.type==='code'&&!e.shiftKey){e.preventDefault();insertPlain(ed,'  ');return;}if(LIST.has(b.type)&&!(e.shiftKey&&!(Number(b.indent)>0))){e.preventDefault();readBlock(ed);indentBlocks([b.id],e.shiftKey?-1:1);}return;}
  if(key==='Backspace'&&!e.altKey&&!mod){if(collapsed&&selectionOffsets(ed).start===0){e.preventDefault();onBackspaceAtStart(ed);}return;}
  if(key==='Delete'&&!e.altKey&&!mod){if(collapsed&&selectionOffsets(ed).start>=contentLength(ed)){e.preventDefault();onDeleteAtEnd(ed);}return;}
  if(key==='ArrowUp'||key==='ArrowDown'){
   const up=key==='ArrowUp';if(e.altKey||mod)return;const index=indexOf(b.id);
   if(e.shiftKey){const {start,end}=selectionOffsets(ed);if(up?start===0&&lineEdge(ed,true):end>=contentLength(ed)&&lineEdge(ed,false)){const next=blocks[index+(up?-1:1)];e.preventDefault();readBlock(ed);if(next)selectRange(b.id,next.id);else selectBlocks([b.id]);}return;}
   if(!lineEdge(ed,up))return;
   const target=neighbor(index,up?-1:1);
   if(!target){if(!up&&b.type==='code'){e.preventDefault();readBlock(ed);beginChange();const fresh=freshBlock();blocks.push(fresh);commit();render();focusBlock(fresh.id);}return;}
   e.preventDefault();closePopup();const rect=caretRect();focusBlock(target.id,{at:up?'end':'start',x:rect?.left,fromAbove:!up});return;
  }
  if((key==='ArrowLeft'||key==='ArrowRight')&&!e.shiftKey&&!e.altKey&&!mod&&collapsed){
   const {start}=selectionOffsets(ed),index=indexOf(b.id);
   const target=key==='ArrowLeft'?start===0&&neighbor(index,-1):start>=contentLength(ed)&&neighbor(index,1);
   if(target){e.preventDefault();focusBlock(target.id,{at:key==='ArrowLeft'?'end':'start'});}
  }
 }
 function tableKey(e,el){
  const b=block(el.dataset.tableCell);if(!b)return;const row=Number(el.dataset.cellRow),column=Number(el.dataset.cellColumn);
  if(e.key==='Enter'&&e.shiftKey){e.preventDefault();replaceSource(el,'\n',sourceSelection(el)||{});return;}
  if(e.key==='Tab'||e.key==='Enter'){readCell(el);const position=tableCellPosition(b,{row,column},e.key,{shift:e.shiftKey});if(position.leave)return;e.preventDefault();e.stopPropagation();if(position.appendRow){beginChange();blocks[indexOf(b.id)]=insertTableRow(b);commit();render();}focusCell(cellAt(b.id,position.row,position.column));return;}
  if(e.key==='ArrowUp'&&!e.shiftKey&&lineEdge(el,true)){e.preventDefault();if(row>-1)focusCell(cellAt(b.id,row-1,column));else{const previous=blocks[indexOf(b.id)-1];if(previous)focusBlock(previous.id,{at:'end'});}return;}
  if(e.key==='ArrowDown'&&!e.shiftKey&&lineEdge(el,false)){e.preventDefault();if(row<b.rows.length-1)focusCell(cellAt(b.id,row+1,column));else{const next=blocks[indexOf(b.id)+1];if(next)focusBlock(next.id,{at:'start'});else{readAll();beginChange();const fresh=freshBlock();blocks.push(fresh);commit();render();focusBlock(fresh.id);}}}
 }
 function toggleTitleKey(e,el){
  const b=block(el.dataset.toggleTitle);if(!b)return;const index=indexOf(b.id);
  if(e.key==='Enter'){e.preventDefault();readAll();beginChange();b.open=true;editingToggles.add(b.id);commit();renderBlock(b.id);blockEl(b.id)?.querySelector('[data-toggle-body]')?.focus();return;}
  if(e.key==='ArrowUp'&&blocks[index-1]){e.preventDefault();focusBlock(blocks[index-1].id,{at:'end'});return;}
  if(e.key==='ArrowDown'){const body=b.open&&blockEl(b.id)?.querySelector('[data-toggle-body]');e.preventDefault();if(body)body.focus();else if(blocks[index+1])focusBlock(blocks[index+1].id,{at:'start'});return;}
  if(e.key==='Backspace'&&!el.value&&el.selectionStart===0){e.preventDefault();readAll();beginChange();blocks[index]=convert(b,'paragraph');editingToggles.delete(b.id);commit();render();focusBlock(b.id,{at:'start'});}
 }
 function toggleBodyKey(e,el){
  const b=block(el.dataset.toggleBody);if(!b)return;const index=indexOf(b.id);
  if(e.key==='ArrowDown'&&el.selectionStart===el.value.length&&blocks[index+1]){e.preventDefault();focusBlock(blocks[index+1].id,{at:'start'});return;}
  if(e.key==='ArrowUp'&&el.selectionStart===0){e.preventDefault();blockEl(b.id)?.querySelector('[data-toggle-title]')?.focus();}
 }

 // Clipboard and drag and drop
 const clipboard=e=>{
  if(mode!=='blocks'||!root.isConnected||!e.clipboardData)return;const cut=e.type==='cut';
  if(selected.size&&(doc.activeElement===list||root.contains(doc.activeElement))){readAll();const ids=orderedSelection(),md=serializeNoteBlocks(ids.map(block));e.clipboardData.setData('text/plain',md);e.clipboardData.setData('text/html',renderMarkdown(md));e.clipboardData.setData(MD_MIME,md);e.preventDefault();if(cut)removeBlocks(ids);return;}
  const ed=selectionEditable(),sel=win.getSelection();if(!ed||sel.isCollapsed||block(ed.dataset.blockEdit)?.type==='code')return;
  const md=serializeInlineFragment(sel.getRangeAt(0).cloneContents()).replace(/^\n/,'');
  e.clipboardData.setData('text/plain',sel.toString());e.clipboardData.setData('text/html',renderInline(md));e.clipboardData.setData(MD_MIME,md);e.preventDefault();
  if(cut){beginChange();sel.getRangeAt(0).deleteContents();cleanZwsp(ed);updateEmpty(ed);readBlock(ed);commit();}
 };
 on(doc,'copy',clipboard);on(doc,'cut',clipboard);
 on(root,'paste',e=>{
  if(mode!=='blocks')return;const t=e.target,data=e.clipboardData;if(!data||t.closest?.('.block-editor-linkform,[data-toggle-title],[data-toggle-body],[data-code-lang]'))return;
  const plain=data.getData('text/plain').replace(/\r\n?/g,'\n');
  if(t.matches?.('[data-table-cell]')){e.preventDefault();replaceSource(t,plain,sourceSelection(t)||{});return;}
  const markdown=data.getData(MD_MIME),html=data.getData('text/html'),rich=markdown||(html&&RICH_HTML.test(html)?htmlToMarkdown(html):''),source=rich||plain;
  if(!source)return;e.preventDefault();
  if(selected.size){replaceSelectedBlocks(source);return;}
  const ed=t.closest?.('[data-block-edit]');if(!ed)return;
  if(block(ed.dataset.blockEdit)?.type==='code'){insertPlain(ed,plain);return;}
  const url=!markdown&&/^\s*https?:\/\/\S+\s*$/.test(plain)&&safeMarkdownUrl(plain.trim());
  if(url&&!win.getSelection().isCollapsed){const {start,end}=selectionOffsets(ed);beginChange();readBlock(ed);applyMark(ed,start,end,'link',newLink(url));readBlock(ed);commit();const id=ed.dataset.blockEdit;renderBlock(id);const el=editableOf(id);if(el){el.focus({preventScroll:true});placeCaret(el,end);}return;}
  pasteInto(ed,source,{rich:!!rich});
 });
 function dropBefore(y){for(const el of list.children){if(!el.dataset.blockId||drag?.ids.includes(el.dataset.blockId))continue;const r=el.getBoundingClientRect();if(y<r.top+r.height/2)return el;}return null;}
 on(root,'dragstart',e=>{
  const handle=e.target.closest?.('[data-block-drag]');if(!handle)return;const id=handle.dataset.blockDrag;readAll();closePopup();
  drag={ids:selected.has(id)?orderedSelection():[id]};e.dataTransfer.setData('application/x-still-block',drag.ids.join(','));e.dataTransfer.effectAllowed='move';
  const el=blockEl(id);if(el)e.dataTransfer.setDragImage(el,12,12);for(const dragged of drag.ids)blockEl(dragged)?.classList.add('is-dragging');
 });
 on(list,'dragover',e=>{if(!drag)return;e.preventDefault();e.dataTransfer.dropEffect='move';const before=dropBefore(e.clientY),last=[...list.children].filter(el=>el.dataset.blockId).at(-1);list.append(indicator);indicator.hidden=false;indicator.style.top=(before?before.offsetTop:last?last.offsetTop+last.offsetHeight:0)-1+'px';});
 on(list,'dragleave',e=>{if(drag&&!list.contains(e.relatedTarget))indicator.hidden=true;});
 // Text, links or HTML dragged in from elsewhere go through the paste path; drags of a selection inside one block,
 // and of files, keep the browser's behaviour.
 on(root,'dragstart',e=>{if(!e.target.closest?.('[data-block-drag]'))textDrag=true;});
 on(root,'dragend',()=>{textDrag=false;});
 on(list,'drop',e=>{
  if(drag||textDrag||mode!=='blocks'||!e.dataTransfer)return;const ed=e.target.closest?.('[data-block-edit]'),data=e.dataTransfer;if(!ed||block(ed.dataset.blockEdit)?.type==='code')return;
  const markdown=data.getData(MD_MIME),html=data.getData('text/html'),plain=data.getData('text/plain').replace(/\r\n?/g,'\n'),rich=markdown||(html&&RICH_HTML.test(html)?htmlToMarkdown(html):''),source=rich||plain;if(!source)return;
  e.preventDefault();const range=doc.caretRangeFromPoint?.(e.clientX,e.clientY);ed.focus({preventScroll:true});
  if(range&&ed.contains(range.startContainer)){const sel=win.getSelection();sel.removeAllRanges();sel.addRange(range);}else placeCaret(ed,contentLength(ed));
  pasteInto(ed,source,{rich:!!rich});
 });
 on(list,'drop',e=>{if(!drag)return;e.preventDefault();const before=dropBefore(e.clientY),ids=drag.ids;drag=null;indicator.hidden=true;moveBlocksBefore(ids,before?.dataset.blockId||null);});
 on(root,'dragend',()=>{drag=null;indicator.hidden=true;for(const el of list.querySelectorAll('.is-dragging'))el.classList.remove('is-dragging');});
 on(doc,'selectionchange',()=>{if(!selFrame)selFrame=win.requestAnimationFrame(()=>{selFrame=0;selectionChanged();});});
 const reposition=()=>{if(popupState)place(popup,popupAnchor());if(!toolbar.hidden){const sel=win.getSelection();if(sel.rangeCount)place(toolbar,sel.getRangeAt(0).getBoundingClientRect(),{above:true,gap:8});}};
 on(win,'scroll',reposition,{capture:true,passive:true});on(win,'resize',reposition);
 on(textarea,'input',()=>external({coalesce:mode==='markdown'}));
 on(textarea,'input',()=>{if(mode==='markdown')autosize();});

 setMode(mode);
 return {
  root,
  getMarkdown(){if(mode!=='blocks')return textarea.value;readAll();const value=serializeNoteBlocks(blocks);if(value!==lastSnapshot)commit({coalesce:true});return lastSnapshot;},
  setMarkdown,
  getSelection:getSelectionInfo,
  command(type,args={}){
   const name={heading:'h2',task:'todo'}[type]||type;
   if(['bold','italic','strike','code-inline'].includes(type)){format(type==='code-inline'?'code':type);return;}
   if(['link','image','file'].includes(name)){
    if(mode!=='blocks')setMode('blocks');
    if(args.url){const href=safeMarkdownUrl(args.url);if(!href){report('Use an https://, http:// or mailto: address.');return;}const label=String(args.label||'').trim()||href;const ed=restoreEditorSelection();const markdown=linkMarkdown(escapeText(name==='file'?'File: '+label:label),href,name==='image');if(ed){const {start,end}=selectionOffsets(ed);beginChange();replaceRange(ed,start,end,markdown);}else insertMarkdown(markdown,{at:'end'});return;}
    openLinkForm(name);return;
   }
   if(TEXT.has(name)||['toggle','table','divider'].includes(name))turnInto(name,args);
  },
  format,
  insertMarkdown,
  undo,redo,
  focus({at='end'}={}){
   if(mode==='markdown'){textarea.focus();const p=at==='start'?0:textarea.value.length;textarea.setSelectionRange(p,p);return;}
   if(mode!=='blocks')return;const b=at==='start'?blocks[0]:blocks.at(-1);if(b)focusBlock(b.id,{at});
  },
  setMode,
  getMode:()=>mode,
  destroy(){
   closePopup();hideToolbar();closeLinkForm();clearTimeout(searchTimer);if(selFrame)win.cancelAnimationFrame(selFrame);
   for(const [target,type,fn,opts] of listeners)target.removeEventListener(type,fn,opts);
   root.before(textarea);root.remove();textarea.classList.remove('block-editor-textarea');textarea.style.height='';textarea.hidden=false;
  }
 };
}
