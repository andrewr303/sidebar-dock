// Safe, dependency-free Markdown used by the reader, note cards and the block editor.
// Tables store Markdown cell strings. Untouched imported blocks retain their raw source (_raw), so a note
// re-serializes byte for byte until one of its blocks is edited. No raw HTML is ever rendered and images
// are never fetched: ![label](url) renders as a link.
const uid=()=>globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2);
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const punctuation=/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
export function safeMarkdownUrl(value){
 const raw=String(value??'').trim();if(!raw||/[\u0000-\u0020\u007f]/.test(raw))return '';
 if(/^#[\w:.-]+$/.test(raw))return raw;
 try{const u=new URL(raw);if(['http:','https:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password)return u.href;if(u.protocol==='mailto:'&&/^[^?\s]+@[^?\s]+$/.test(u.pathname))return u.href;}catch{}
 return '';
}

// Task lines are the one rule shared by data-task-index (renderMarkdown) and lib/notes.js (extractTasks,
// toggleTask): every source line matching TASK_LINE is numbered lexically from 0 in document order, including
// lines inside code fences, toggles and hard-break continuations. Only real to-do blocks render a checkbox, and
// each carries the number of its own first line, so an index always names the line to rewrite.
export const TASK_LINE=/^[ \t]*[-*] \[[ xX]\](?: |\r?$)/;
export function taskLineIndices(markdown){let next=0;return String(markdown??'').split('\n').map(line=>TASK_LINE.test(line)?next++:null);}

const svg=(paths,className)=>`<svg class="${className}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
// GitHub alert kinds (> [!TIP]); the label and icon are shared with the block editor.
export const CALLOUT_KINDS={
 note:{label:'Note',icon:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'},
 tip:{label:'Tip',icon:'<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'},
 important:{label:'Important',icon:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v2"/><path d="M12 13h.01"/>'},
 warning:{label:'Warning',icon:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'},
 caution:{label:'Caution',icon:'<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>'}
};
const checkIcon=svg('<path d="M20 6 9 17l-5-5"/>','task-check-icon');

function escapedAt(text,index){let n=0;while(index>0&&text[--index]==='\\')n++;return n%2===1;}
function codeEnd(text,marker,from){for(let i=from;i<text.length;i++){if(text[i]!=='`')continue;const run=text.slice(i).match(/^`+/)[0];if(run.length===marker.length)return i;i+=run.length-1;}return -1;}
function bracketEnd(text,start){let depth=1;for(let i=start+1;i<text.length;i++){if(escapedAt(text,i))continue;if(text[i]==='[')depth++;if(text[i]===']'&&!--depth)return i;}return -1;}
function destination(text,start){let depth=1;for(let i=start+1;i<text.length;i++){if(escapedAt(text,i))continue;if(text[i]==='(')depth++;if(text[i]===')'&&!--depth)return {end:i,value:text.slice(start+1,i)};}return null;}
function citationMap(sources){return sources===undefined?null:new Map((Array.isArray(sources)?sources:[]).filter(s=>s&&s.id!==undefined).map(s=>[String(s.id),s]));}
function inlineOptions({citations,resolveLink,linkClass}={}){return {citations:citationMap(citations),resolveLink:typeof resolveLink==='function'?resolveLink:null,linkClass,noLinks:false,plain:false};}

// Emphasis follows the CommonMark delimiter-run rules (left/right flanking, intraword underscores never
// open or close, the rule of three), so nested and adjacent formatting written by the editor reads back intact.
const isSpace=ch=>!ch||/\s/u.test(ch),isPunct=ch=>!!ch&&/[\p{P}\p{S}]/u.test(ch);
function delimiterRun(text,i,ch){
 let n=0;while(text[i+n]===ch)n++;
 const before=text[i-1],after=text[i+n];
 const left=!isSpace(after)&&(!isPunct(after)||isSpace(before)||isPunct(before));
 const right=!isSpace(before)&&(!isPunct(before)||isSpace(after)||isPunct(after));
 return {delim:ch,count:n,orig:n,open:ch==='_'?left&&(!right||isPunct(before)):left,close:ch==='_'?right&&(!left||isPunct(after)):right,openTags:'',closeTags:''};
}
function processEmphasis(nodes){
 const stack=nodes.filter(n=>n.delim);if(stack.length>2000)return;
 for(let c=0;c<stack.length;){
  const closer=stack[c];if(!closer.close||!closer.count){c++;continue;}
  let o=c-1;
  for(;o>=0;o--){
   const opener=stack[o];if(opener.delim!==closer.delim||!opener.open||!opener.count)continue;
   if(closer.delim==='~'){if(opener.count===2&&closer.count===2)break;continue;}
   if((opener.close||closer.open)&&(opener.orig+closer.orig)%3===0&&!(opener.orig%3===0&&closer.orig%3===0))continue;
   break;
  }
  if(o<0){if(closer.open)c++;else stack.splice(c,1);continue;}
  const opener=stack[o],use=closer.delim==='~'?2:opener.count>=2&&closer.count>=2?2:1,tag=closer.delim==='~'?'del':use===2?'strong':'em';
  opener.openTags=`<${tag}>`+opener.openTags;closer.closeTags+=`</${tag}>`;opener.count-=use;closer.count-=use;
  stack.splice(o+1,c-o-1);c=o+1;
  if(!opener.count){stack.splice(o,1);c=o;}
  if(!closer.count)stack.splice(c,1);
 }
}
const AUTOLINK=/https?:\/\/[^\s<>"'`]+/iy,WIKI=/\[\[([^[\]\n|]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/y;
// Trailing punctuation and unbalanced closing brackets are not part of a bare URL (GFM autolink rule).
export function trimAutolink(url){
 const count=(value,ch)=>value.split(ch).length-1;
 for(;;){
  const last=url.at(-1);
  if(/[.,;:!?*_~'"]/.test(last))url=url.slice(0,-1);
  else if(last===')'&&count(url,'(')<count(url,')'))url=url.slice(0,-1);
  else if(last===']'&&count(url,'[')<count(url,']'))url=url.slice(0,-1);
  else return url;
 }
}
// [[target]] and [[target|Label]]. With a citations list, ids in that list render as AI source chips (their
// existing contract); with resolveLink, targets render as internal link chips or as a missing-link marker.
function wikiLink(text,i,o){
 WIKI.lastIndex=i;const m=WIKI.exec(text);if(!m)return null;
 const target=m[1].trim(),label=(m[2]||'').trim(),end=i+m[0].length;if(!target)return null;
 if(o.plain)return {end,html:escapeHtml(label||target)};
 if(o.citations&&!m[2]&&/^[\w:.-]+$/.test(m[1])){
  const source=o.citations.get(m[1]);
  if(source)return {end,html:`<button type="button" class="ai-citation" data-ai-action="source" data-id="${escapeHtml(m[1])}" title="${escapeHtml(source.title||'Source')}">${escapeHtml(String(source.title||'Source').slice(0,36))}</button>`};
  if(!o.resolveLink)return {end,html:'<span class="ai-citation-unavailable">[source unavailable]</span>'};
 }
 if(!o.resolveLink)return null;
 let hit=null;try{hit=o.resolveLink(target)||null;}catch{hit=null;}
 const id=hit&&hit.id!=null?String(hit.id):'',shown=label||(id&&id===target&&hit.title?String(hit.title):target);
 const data=` data-target="${escapeHtml(target)}"${label?` data-label="${escapeHtml(label)}"`:''}`;
 if(!id)return {end,html:`<span class="note-link is-missing"${data} title="No matching note">${escapeHtml(shown)}</span>`};
 let extra='';try{extra=String((typeof o.linkClass==='function'?o.linkClass(hit):o.linkClass)||'').trim();}catch{extra='';}
 return {end,html:`<a class="note-link${extra?' '+escapeHtml(extra):''}" href="#" data-id="${escapeHtml(id)}"${hit.type?` data-type="${escapeHtml(hit.type)}"`:''}${data} title="${escapeHtml(hit.title||shown)}">${escapeHtml(shown)}</a>`};
}
function inline(text,depth,o){
 if(depth>10)return escapeHtml(text);
 const nodes=[];let buf='';
 const flush=()=>{if(buf){nodes.push({html:escapeHtml(buf)});buf='';}};
 const push=html=>{flush();nodes.push({html});};
 for(let i=0;i<text.length;){
  const c=text[i];
  if(c==='\\'&&text[i+1]==='\n'){push('<br>');i+=2;continue;}
  if(c==='\\'&&i+1<text.length&&punctuation.test(text[i+1])){buf+=text[i+1];i+=2;continue;}
  if(c==='\n'){push('<br>');i++;continue;}
  if(c==='`'){const run=text.slice(i).match(/^`+/)[0],end=codeEnd(text,run,i+run.length);if(end>=0){let code=text.slice(i+run.length,end).replace(/\n/g,' ');if(code.startsWith(' ')&&code.endsWith(' ')&&code.trim())code=code.slice(1,-1);push('<code>'+escapeHtml(code)+'</code>');i=end+run.length;continue;}buf+=run;i+=run.length;continue;}
  if(c==='['&&text[i+1]==='['&&!o.noLinks&&(o.citations||o.resolveLink||o.plain)){const hit=wikiLink(text,i,o);if(hit){push(hit.html);i=hit.end;continue;}}
  const image=c==='!'&&text[i+1]==='[';
  if((c==='['||image)&&!o.noLinks){const start=image?i+1:i,end=bracketEnd(text,start);if(end>=0&&text[end+1]==='('){const dest=destination(text,end+1);if(dest){let raw=dest.value.trim();if(raw.startsWith('<')&&raw.endsWith('>'))raw=raw.slice(1,-1);const title=/^(\S+?)(?:\s+["']([^"']*)["'])?$/.exec(raw);const href=safeMarkdownUrl((title?.[1]||raw).replace(/\\([()\\])/g,'$1'));if(href){const label=text.slice(start+1,end),external=/^https?:/.test(href);push(`<a class="${image?'markdown-media-link':'markdown-link'}" href="${escapeHtml(href)}"${external?' target="_blank" rel="noopener noreferrer"':''}${title?.[2]?` title="${escapeHtml(title[2])}"`:''}>${image&&!o.plain?'<span>Image · </span>':''}${inline(label||href,depth+1,{...o,noLinks:true})}</a>`);i=dest.end+1;continue;}}}}
  if(c==='<'&&!o.noLinks){const end=text.indexOf('>',i+1);if(end>=0){const href=safeMarkdownUrl(text.slice(i+1,end));if(href){push(`<a class="markdown-link" data-autolink="angle" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text.slice(i+1,end))}</a>`);i=end+1;continue;}}}
  if((c==='h'||c==='H')&&!o.noLinks&&!/[\p{L}\p{N}]/u.test(text[i-1]||'')){AUTOLINK.lastIndex=i;const m=AUTOLINK.exec(text);if(m){const url=trimAutolink(m[0]),href=/^https?:\/\/./i.test(url)&&safeMarkdownUrl(url);if(href){push(`<a class="markdown-link" data-autolink="bare" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);i+=url.length;continue;}}}
  if(c==='*'||c==='_'||c==='~'){const run=delimiterRun(text,i,c);if(c!=='~'||run.count===2){flush();nodes.push(run);}else buf+=c.repeat(run.count);i+=run.count;continue;}
  buf+=c;i++;
 }
 flush();processEmphasis(nodes);
 return nodes.map(n=>n.delim?n.closeTags+escapeHtml(n.delim.repeat(n.count))+n.openTags:n.html).join('');
}
export const renderInline=(text,options={})=>inline(String(text??''),0,inlineOptions(options));
const decodeHtml=html=>html.replace(/<br>/g,'\n').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|#39);/g,(m,e)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[e]));
// Plain text of one inline Markdown string: markers removed, wiki links shown by label, hard breaks as \n.
export function inlineText(text){return decodeHtml(inline(String(text??''),0,{citations:null,resolveLink:null,linkClass:'',noLinks:false,plain:true}));}

export function splitTableRow(line){
 const value=String(line).trim();let cells=[],cell='',code='';
 for(let i=0;i<value.length;i++){
  const c=value[i];if(c==='`'&&(code||!escapedAt(value,i))){const run=value.slice(i).match(/^`+/)[0];if(code===run)code='';else if(!code&&codeEnd(value,run,i+run.length)>=0)code=run;cell+=run;i+=run.length-1;continue;}
  if(c==='|'&&!escapedAt(value,i)&&!code){cells.push(cell.trim());cell='';}else cell+=c;
 }
 cells.push(cell.trim());if(value.startsWith('|'))cells.shift();if(value.endsWith('|')&&!escapedAt(value,value.length-1))cells.pop();return cells;
}
export function isTableDivider(line){const cells=splitTableRow(line);return cells.length>0&&cells.every(c=>/^:?-+:?$/.test(c));}
const alignment=value=>value.startsWith(':')&&value.endsWith(':')?'center':value.endsWith(':')?'right':value.startsWith(':')?'left':'';
export function tableWidth(table){return Math.max(1,table.headers?.length||0,...(table.rows||[]).map(r=>r.length));}
export function createTableBlock({headers=['Column 1','Column 2'],rows=[['',''],['','']],alignments=[]}={}){return {id:uid(),type:'table',text:'',headers:headers.map(String),rows:rows.map(r=>r.map(String)),alignments:[...alignments]};}
export function escapeTableCell(value){const text=String(value??'').replace(/\r\n?|\n/g,'<br>');let out='';for(let i=0;i<text.length;i++){if(text[i]==='|'&&!escapedAt(text,i))out+='\\';out+=text[i];}return out;}
// GFM table cells hold Markdown source, including existing backslash escapes.
// A cell newline becomes the fixed <br> token; no other raw HTML is rendered.
// Pasted tabs remain in that cell. Row/column changes preserve surplus cells.
export function serializeTable(table){
 const width=tableWidth(table),row=values=>'| '+Array.from({length:width},(_,i)=>escapeTableCell(values[i]??'')).join(' | ')+' |';
 const head=row(table.headers||[]),separator=row(Array.from({length:width},(_,i)=>({left:':---',right:'---:',center:':---:'}[table.alignments?.[i]]||'---')));
 return [head,separator,...(table.rows||[]).map(row)].join('\n');
}
function checkedTable(table){if(!table||table.type!=='table'||!Array.isArray(table.headers)||!Array.isArray(table.rows))throw new Error('Choose a table block.');return structuredClone(table);}
export function updateTableCell(table,row,column,value){const t=checkedTable(table),width=tableWidth(t);if(!Number.isInteger(row)||row< -1||row>=t.rows.length||!Number.isInteger(column)||column<0||column>=width)throw new Error('Choose an existing table cell.');const values=row<0?t.headers:t.rows[row];while(values.length<width)values.push('');values[column]=String(value??'');return t;}
export function insertTableRow(table,index=table.rows.length){const t=checkedTable(table);if(!Number.isInteger(index)||index<0||index>t.rows.length)throw new Error('Choose a valid row position.');t.rows.splice(index,0,Array(tableWidth(t)).fill(''));return t;}
export function removeTableRow(table,index){const t=checkedTable(table);if(!Number.isInteger(index)||index<0||index>=t.rows.length)throw new Error('Choose an existing body row.');t.rows.splice(index,1);return t;}
export function insertTableColumn(table,index=tableWidth(table)){const t=checkedTable(table),width=tableWidth(t);if(!Number.isInteger(index)||index<0||index>width)throw new Error('Choose a valid column position.');for(const row of [t.headers,...t.rows]){while(row.length<width)row.push('');row.splice(index,0,'');}while(t.alignments.length<width)t.alignments.push('');t.alignments.splice(index,0,'');return t;}
export function removeTableColumn(table,index){const t=checkedTable(table),width=tableWidth(t);if(width===1)throw new Error('A table needs at least one column.');if(!Number.isInteger(index)||index<0||index>=width)throw new Error('Choose an existing column.');for(const row of [t.headers,...t.rows]){while(row.length<width)row.push('');row.splice(index,1);}t.alignments.splice(index,1);return t;}
export function tableCellPosition(table,{row,column},key,{shift=false}={}){const width=tableWidth(table),lastRow=table.rows.length-1;if(key==='Enter')return {row:row+1,column,appendRow:row>=lastRow};const flat=(row+1)*width+column+(shift?-1:1);if(flat<0)return {leave:true};const nextRow=Math.floor(flat/width)-1;return {row:nextRow,column:flat%width,appendRow:nextRow>lastRow};}

export function createToggleBlock({title='Toggle',text='',open=true}={}){return {id:uid(),type:'toggle',title:String(title).replace(/\r\n?|\n/g,' '),text:String(text),open:!!open};}
// Portable toggle format: :::toggle [open|closed] Title\nMarkdown body\n:::.
// The matching colon-only fence is extended past every such line in the body,
// allowing nested toggles, code, literal fences and blank lines to round-trip.
export function serializeToggle(block){let longest=2;for(const line of String(block.text||'').split('\n'))if(/^:{3,}$/.test(line))longest=Math.max(longest,line.length);const fence=':'.repeat(longest+1);return `${fence}toggle [${block.open?'open':'closed'}] ${String(block.title||'Toggle').replace(/\r\n?|\n/g,' ')}\n${block.text||''}\n${fence}`;}

// Block grammar (one block per line unless noted):
//  - list items (- , * , 1. , - [ ] ) nest by indentation; `indent` is the nesting level, not a column count
//  - a line ending in an unescaped backslash is a hard break: the next line continues the same block
//  - consecutive "> " lines form one quote; "> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]" starts a callout
//    whose "> " lines are its body (the legacy one-line "> [!NOTE] text" still reads as a callout)
// Edited blocks serialize canonically; new syntax only claims lines that used to be plain paragraphs.
const LIST_TYPES=new Set(['bullet','number','todo']);
const LIST_ITEM=/^([ \t]*)(?:([-*]) \[([ xX])\](?: ([\s\S]*)|\r?$)|([-*]) ([\s\S]*)|(\d+)\. ([\s\S]*))$/;
const ALERT=/^> \[!(note|tip|important|warning|caution)\](?:[ \t]*\r?$| ([\s\S]*)$)/i,QUOTE_CONT=/^>(?: |\r?$)/;
const columns=lead=>{let w=0;for(const ch of lead)w=ch==='\t'?w+4-(w%4):w+1;return w;};
const hardBreak=line=>{const value=line.replace(/\r$/,'');return value.endsWith('\\')&&!escapedAt(value,value.length-1);};
const startsBlock=line=>/^\s*$/.test(line)||LIST_ITEM.test(line)||/^(?:#{1,3} |>|`{3,}|~{3,}|:{3,}toggle|---\s*$)/.test(line);
function signature(block){const value={};for(const [key,entry] of Object.entries(block))if(key!=='id'&&!key.startsWith('_'))value[key]=entry;return JSON.stringify(value);}
function remember(block,raw,start,end){block._raw=raw;block._lineStart=start;block._lineEnd=end;block._signature=signature(block);return block;}
export function parseNoteBlocks(markdown=''){
 const lines=String(markdown).split('\n'),blocks=[];let stack=[];
 const add=(block,start,end)=>{blocks.push(remember(block,lines.slice(start,end+1).join('\n'),start,end));return block;};
 const continued=(i,text)=>{while(hardBreak(text)&&i+1<lines.length&&!startsBlock(lines[i+1]))text=text.replace(/\\\r?$/,'')+'\n'+lines[++i].replace(/^[ \t]+/,'');return {text,end:i};};
 for(let i=0;i<lines.length;i++){
  const start=i,line=lines[i];
  const code=/^(`{3,}|~{3,})([^\n]*)$/.exec(line);if(code){stack=[];const language=code[2],body=[];while(++i<lines.length){if(new RegExp('^'+code[1][0]+'{'+code[1].length+',}\\s*$').test(lines[i]))break;body.push(lines[i]);}i=Math.min(i,lines.length-1);add({id:uid(),type:'code',text:body.join('\n'),language},start,i);continue;}
  const toggle=/^(:{3,})toggle(?: \[(open|closed)\])?(?: (.*))?$/.exec(line);if(toggle){const body=[];let end=i+1;while(end<lines.length&&lines[end]!==toggle[1])body.push(lines[end++]);if(end<lines.length){stack=[];i=end;add({id:uid(),type:'toggle',title:toggle[3]||'Toggle',text:body.join('\n'),open:toggle[2]==='open'},start,i);continue;}}
  if(i+1<lines.length&&line.includes('|')&&isTableDivider(lines[i+1])){const headers=splitTableRow(line),separator=splitTableRow(lines[i+1]);if(headers.length===separator.length){stack=[];const rows=[];i++;while(i+1<lines.length&&lines[i+1].trim()&&!/^\s*(?:>|#{1,6}\s|`{3,}|~{3,}|:{3,}|[-*+]\s|\d+\.\s)/.test(lines[i+1])&&!/^\s*([-*_])\1\1+\s*$/.test(lines[i+1]))rows.push(splitTableRow(lines[++i]));const table=createTableBlock({headers,rows,alignments:separator.map(alignment)});add(table,start,i);continue;}}
  const base={id:uid(),checked:false,language:''};
  const item=LIST_ITEM.exec(line);
  if(item){
   const lead=item[1],width=columns(lead);while(stack.length&&width<stack.at(-1))stack.pop();const indent=stack.length;
   let block;
   if(item[2]!==undefined)block={...base,type:'todo',text:item[4]??'',checked:item[3]!==' '};
   else if(item[5]!==undefined)block={...base,type:'bullet',text:item[6]};
   else{const ordinal=Number(item[7]);block={...base,type:'number',text:item[8],ordinal:Number.isSafeInteger(ordinal)?ordinal:1};}
   block.indent=indent;stack.push(width+(block.type==='number'?item[7].length+1:1)+1);
   const joined=continued(i,block.text);block.text=joined.text;i=joined.end;
   add(block,start,i);block._lead=lead;block._indent=indent;continue;
  }
  stack=[];
  if(/^---\s*$/.test(line)){add({...base,type:'divider',text:''},start,i);continue;}
  const heading=/^(#{1,3}) /.exec(line);if(heading){add({...base,type:'h'+heading[1].length,text:line.slice(heading[0].length)},start,i);continue;}
  const alert=ALERT.exec(line);
  if(alert||/^> /.test(line)){const body=alert?alert[2]!==undefined?[alert[2]]:[]:[line.slice(2)];while(i+1<lines.length&&QUOTE_CONT.test(lines[i+1])&&!ALERT.test(lines[i+1]))body.push(lines[++i].replace(/^> ?/,''));add(alert?{...base,type:'callout',text:body.join('\n'),kind:alert[1].toLowerCase()}:{...base,type:'quote',text:body.join('\n')},start,i);continue;}
  const joined=continued(i,line);i=joined.end;add({...base,type:'paragraph',text:joined.text},start,i);
 }
 return blocks.length?blocks:[{id:uid(),type:'paragraph',text:'',checked:false,language:''}];
}

// List numbering and indentation are computed per nesting level. Untouched items keep their raw lines; an
// edited item keeps its original indentation while its level is unchanged, otherwise it aligns with its
// previous sibling or under its parent's content column, so the structure reads back the same.
function listLayout(blocks){
 let levels=[];
 return blocks.map(b=>{
  if(!LIST_TYPES.has(b.type)){levels=[];return null;}
  const raw=typeof b._raw==='string'&&b._signature===signature(b),indent=Math.max(0,Math.min(Number(b.indent)||0,levels.length));
  levels.length=Math.min(levels.length,indent+1);
  const previous=levels[indent],number=b.type!=='number'?0:previous?.type==='number'?previous.number+1:Number.isSafeInteger(b.ordinal)?b.ordinal:1;
  let lead,marker;
  if(raw){const m=/^([ \t]*)(\d+\.|[-*])/.exec(b._raw);lead=m?m[1]:'';marker=m?m[2].length:1;}
  else{
   marker=b.type==='number'?String(number).length+1:1;
   if(typeof b._lead==='string'&&b._indent===indent)lead=b._lead;
   else{const parent=indent?levels[indent-1]?.content??indent*2:0;lead=' '.repeat(previous&&previous.width>=parent?previous.width:parent);}
  }
  const width=columns(lead);levels[indent]={type:b.type,number,width,content:width+marker+1};
  return {indent,number,lead,content:width+marker+1};
 });
}
export function listNumbers(blocks){return listLayout(blocks).map(entry=>entry&&entry.number);}
function escapeLineStart(line){
 const [,ws,rest]=/^([ \t]*)([\s\S]*)$/.exec(line);
 if(/^[-*] /.test(rest))return ws+'\\'+rest;
 const number=/^(\d+)\. /.exec(rest);if(number)return ws+number[1]+'\\'+rest.slice(number[1].length);
 if(!ws&&/^(?:#{1,6} |>|`{3,}|~{3,}|:{3,}|---\s*$)/.test(rest))return '\\'+rest;
 return line;
}
// Newlines inside a text block become CommonMark hard breaks (a trailing backslash); continuation lines that
// would otherwise start a new block are escaped, so a block never splits when the note is reopened.
function hardLines(text,first,indent=''){
 const lines=String(text??'').replace(/\n+$/,'').split('\n');let out=first(lines[0]);
 for(let k=1;k<lines.length;k++)out+=(hardBreak(lines[k-1])?'\n':'\\\n')+indent+escapeLineStart(lines[k]);
 return out;
}
const quoteLines=(text,first='')=>String(text??'').replace(/\n+$/,'').split('\n').map((line,k)=>{const value=/^\[!/.test(line)?'\\'+line:line;return value||(k===0&&!first)?'> '+value:'>';});
export function serializeBlockParts(blocks){
 const layout=listLayout(blocks);
 return blocks.map((b,index)=>{
  const previous=blocks[index-1];
  const gap=previous&&((['quote','callout'].includes(previous.type)&&b.type==='quote')||(previous.type==='table'&&(b.type==='table'||(b.type==='paragraph'&&String(b.text||'').trim()))))?'\n':'';
  if(typeof b._raw==='string'&&b._signature===signature(b))return gap+b._raw;
  if(b.type==='table')return gap+serializeTable(b);if(b.type==='toggle')return gap+serializeToggle(b);if(b.type==='divider')return gap+'---';
  if(b.type==='code'){let count=3;for(const line of String(b.text||'').split('\n')){const m=/^(`+)/.exec(line);if(m)count=Math.max(count,m[1].length+1);}const fence='`'.repeat(count);return gap+fence+(b.language||'')+'\n'+(b.text||'')+'\n'+fence;}
  if(['h1','h2','h3'].includes(b.type))return gap+'#'.repeat(Number(b.type[1]))+' '+String(b.text||'').replace(/\n+$/,'').replace(/\n/g,' ');
  if(b.type==='quote')return gap+quoteLines(b.text).join('\n');
  if(b.type==='callout'){const kind=CALLOUT_KINDS[b.kind]?b.kind:'note',body=String(b.text||'').replace(/\n+$/,'');return gap+`> [!${kind.toUpperCase()}]`+(body?'\n'+quoteLines(body,'x').join('\n'):'');}
  if(LIST_TYPES.has(b.type)){
   const {lead,number,content}=layout[index],marker=b.type==='number'?`${number}. `:b.type==='todo'?(b.checked?'- [x] ':'- [ ] '):'- ';
   return gap+lead+marker+hardLines(b.text,line=>b.type==='bullet'&&/^\[[ xX]\](?: |$)/.test(line)?'\\'+line:line,' '.repeat(content));
  }
  return gap+hardLines(b.text,escapeLineStart);
 });
}
export function serializeNoteBlocks(blocks){return serializeBlockParts(blocks).join('\n');}

function decodeCellPipes(text){return text.replace(/(\\+)\|/g,(full,slashes)=>slashes.length%2?'\\'.repeat(slashes.length-1)+'|':full);}
export function renderTableCell(value,options={}){const source=decodeCellPipes(String(value??''));let out='',chunk='',code='';for(let i=0;i<source.length;i++){if(source[i]==='`'&&(code||!escapedAt(source,i))){const run=source.slice(i).match(/^`+/)[0];if(code===run)code='';else if(!code&&codeEnd(source,run,i+run.length)>=0)code=run;chunk+=run;i+=run.length-1;continue;}const br=!code&&source.slice(i).match(/^<br\s*\/?>/i);if(br){out+=renderInline(chunk,options)+'<br>';chunk='';i+=br[0].length-1;continue;}if(source[i]==='\n'&&!code){out+=renderInline(chunk,options)+'<br>';chunk='';continue;}chunk+=source[i];}return out+renderInline(chunk,options);}
function renderTable(block,compact,options){const width=tableWidth(block),align=i=>['left','right','center'].includes(block.alignments?.[i])?` style="text-align:${block.alignments[i]}"`:'';return `<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${Array.from({length:width},(_,i)=>`<th scope="col"${align(i)}>${renderTableCell(block.headers[i]||'',options)}</th>`).join('')}</tr></thead><tbody>${(compact?block.rows.slice(0,3):block.rows).map(row=>'<tr>'+Array.from({length:width},(_,i)=>`<td${align(i)}>${renderTableCell(row[i]||'',options)}</td>`).join('')+'</tr>').join('')}</tbody></table></div>`;}
export function renderCallout(kind,body){const entry=CALLOUT_KINDS[kind]||CALLOUT_KINDS.note;return `<div class="markdown-callout" data-kind="${CALLOUT_KINDS[kind]?kind:'note'}" role="note"><p class="markdown-callout-title">${svg(entry.icon,'markdown-callout-icon')}<span>${entry.label}</span></p><div class="markdown-callout-body">${body}</div></div>`;}
// options: interactiveTasks, compact (cards: first 12 blocks, closed toggles, 3 table rows), citations (AI answers),
// resolveLink(title) -> { id, title, type } | null and linkClass (string or (link) => string) for [[wiki links]].
// Wrap the output in an element with class "markdown-body" to get the shared reading styles.
export function renderMarkdown(markdown,{interactiveTasks=false,compact=false,citations,resolveLink,linkClass}={}){
 const options={citations,resolveLink,linkClass},o=inlineOptions(options),render=value=>inline(String(value??''),0,o);
 const source=String(markdown??''),taskIndices=taskLineIndices(source);
 const task=(b,offset)=>{const index=taskIndices[offset+b._lineStart],label=escapeHtml(inlineText(b.text)||'To-do');return `<div class="task-line ${b.checked?'done':''}">${interactiveTasks&&index!==null&&index!==undefined?`<input type="checkbox" data-task-index="${index}"${b.checked?' checked':''} aria-label="${label}">`:`<span class="task-check ${b.checked?'checked':''}" aria-hidden="true">${b.checked?checkIcon:''}</span>`}<span>${render(b.text)}</span></div>`;};
 const list=(items,offset)=>{
  const roots=[],path=[];
  for(const b of items){const depth=Math.min(Number(b.indent)||0,path.length);path.length=depth;const node={b,children:[]};(depth?path[depth-1].children:roots).push(node);path.push(node);}
  const draw=nodes=>{let out='',kind=null;const close=()=>{if(kind)out+=`</${kind}>`;kind=null;};
   for(const {b,children} of nodes){
    if(b.type==='todo'){close();out+=task(b,offset)+(children.length?`<div class="task-children">${draw(children)}</div>`:'');continue;}
    const tag=b.type==='number'?'ol':'ul';if(kind!==tag){close();out+='<'+tag+(tag==='ol'&&Number.isSafeInteger(b.ordinal)&&b.ordinal!==1?` start="${b.ordinal}"`:'')+'>';kind=tag;}
    out+='<li>'+render(b.text)+(children.length?draw(children):'')+'</li>';
   }close();return out;};
  return draw(roots);
 };
 const draw=(text,offset=0,depth=0)=>{if(depth>16)return '<p>'+escapeHtml(text)+'</p>';const blocks=parseNoteBlocks(text),rows=compact?blocks.slice(0,12):blocks;let out='';
  for(let k=0;k<rows.length;k++){
   const b=rows[k];
   if(LIST_TYPES.has(b.type)){let end=k;while(end+1<rows.length&&LIST_TYPES.has(rows[end+1].type))end++;out+=list(rows.slice(k,end+1),offset);k=end;continue;}
   if(b.type==='table'){out+=renderTable(b,compact,options);continue;}
   if(b.type==='toggle'){out+=`<details class="markdown-toggle"${b.open&&!compact?' open':''}><summary>${render(b.title)}</summary><div>${draw(b.text,offset+b._lineStart+1,depth+1)}</div></details>`;continue;}
   if(b.type==='code'){out+=`<pre class="markdown-code"><code${b.language?` data-language="${escapeHtml(b.language.trim())}"`:''}>${escapeHtml(b.text)}</code></pre>`;continue;}
   if(['h1','h2','h3'].includes(b.type)){const tag=compact?'h3':b.type;out+=`<${tag}>${render(b.text)}</${tag}>`;continue;}
   if(b.type==='divider'){out+='<hr class="markdown-divider">';continue;}
   if(b.type==='quote'){out+='<blockquote>'+render(b.text)+'</blockquote>';continue;}
   if(b.type==='callout'){out+=renderCallout(b.kind,render(b.text));continue;}
   out+=b.text.trim()?'<p>'+render(b.text)+'</p>':'<div class="paragraph-space"></div>';
  }return out;
 };
 return draw(source);
}
// Plain text of a whole note (excerpts, word counts, search snippets).
export function plainText(markdown){
 const walk=(text,depth)=>depth>16?'':parseNoteBlocks(text).map(b=>b.type==='code'?b.text:b.type==='table'?[b.headers,...b.rows].map(row=>row.map(cell=>inlineText(decodeCellPipes(String(cell)).replace(/<br\s*\/?>/gi,' '))).join(' ')).join('\n'):b.type==='toggle'?[inlineText(b.title),walk(b.text,depth+1)].filter(Boolean).join('\n'):b.type==='divider'?'':inlineText(b.text)).join('\n');
 return walk(String(markdown??''),0);
}
