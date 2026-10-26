// Safe, dependency-free Markdown used by the reader and block editor.
// Tables store Markdown cell strings. Untouched imported blocks retain their raw source.
const uid=()=>globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2);
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const punctuation=/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
export function safeMarkdownUrl(value){
 const raw=String(value??'').trim();if(!raw||/[\u0000-\u0020\u007f]/.test(raw))return '';
 if(/^#[\w:.-]+$/.test(raw))return raw;
 try{const u=new URL(raw);if(['http:','https:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password)return u.href;if(u.protocol==='mailto:'&&/^[^?\s]+@[^?\s]+$/.test(u.pathname))return u.href;}catch{}
 return '';
}
function escapedAt(text,index){let n=0;while(index>0&&text[--index]==='\\')n++;return n%2===1;}
function markerEnd(text,marker,from){let i=text.indexOf(marker,from);while(i>=0){if(!escapedAt(text,i))return i;i=text.indexOf(marker,i+marker.length);}return -1;}
function codeEnd(text,marker,from){for(let i=from;i<text.length;i++){if(text[i]!=='`')continue;const run=text.slice(i).match(/^`+/)[0];if(run.length===marker.length)return i;i+=run.length-1;}return -1;}
function bracketEnd(text,start){let depth=1;for(let i=start+1;i<text.length;i++){if(escapedAt(text,i))continue;if(text[i]==='[')depth++;if(text[i]===']'&&!--depth)return i;}return -1;}
function destination(text,start){let depth=1;for(let i=start+1;i<text.length;i++){if(escapedAt(text,i))continue;if(text[i]==='(')depth++;if(text[i]===')'&&!--depth)return {end:i,value:text.slice(start+1,i)};}return null;}
function citationMap(sources){return sources===undefined?null:new Map((Array.isArray(sources)?sources:[]).filter(s=>s&&s.id!==undefined).map(s=>[String(s.id),s]));}
function inline(text,depth=0,citations=null){
 if(depth>10)return escapeHtml(text);let out='';
 for(let i=0;i<text.length;){
  const c=text[i];
  if(c==='\\'&&i+1<text.length&&punctuation.test(text[i+1])){out+=escapeHtml(text[i+1]);i+=2;continue;}
  if(c==='`'){const run=text.slice(i).match(/^`+/)[0],end=codeEnd(text,run,i+run.length);if(end>=0){let code=text.slice(i+run.length,end).replace(/\n/g,' ');if(code.startsWith(' ')&&code.endsWith(' ')&&code.trim())code=code.slice(1,-1);out+='<code>'+escapeHtml(code)+'</code>';i=end+run.length;continue;}}
  if(citations&&text.startsWith('[[',i)){const match=/^\[\[([\w:.-]+)\]\]/.exec(text.slice(i));if(match){const source=citations.get(match[1]);out+=source?`<button type="button" class="ai-citation" data-ai-action="source" data-id="${escapeHtml(match[1])}" title="${escapeHtml(source.title||'Source')}">${escapeHtml(String(source.title||'Source').slice(0,36))}</button>`:'<span class="ai-citation-unavailable">[source unavailable]</span>';i+=match[0].length;continue;}}
  const image=c==='!'&&text[i+1]==='[';if(c==='['||image){const start=image?i+1:i,end=bracketEnd(text,start);if(end>=0&&text[end+1]==='('){const dest=destination(text,end+1);if(dest){let raw=dest.value.trim();if(raw.startsWith('<')&&raw.endsWith('>'))raw=raw.slice(1,-1);const title=/^(\S+?)(?:\s+["']([^"']*)["'])?$/.exec(raw);const href=safeMarkdownUrl((title?.[1]||raw).replace(/\\([()\\])/g,'$1'));if(href){const label=text.slice(start+1,end),external=/^https?:/.test(href);out+=`<a class="${image?'markdown-media-link':'markdown-link'}" href="${escapeHtml(href)}"${external?' target="_blank" rel="noopener noreferrer"':''}${title?.[2]?` title="${escapeHtml(title[2])}"`:''}>${image?'<span>Image · </span>':''}${inline(label||href,depth+1)}</a>`;i=dest.end+1;continue;}}}}
  if(c==='<'){const end=text.indexOf('>',i+1);if(end>=0){const href=safeMarkdownUrl(text.slice(i+1,end));if(href){out+=`<a class="markdown-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text.slice(i+1,end))}</a>`;i=end+1;continue;}}}
  let marked=false;for(const [marker,tag] of [['**','strong'],['__','strong'],['~~','del'],['*','em'],['_','em']]){if(!text.startsWith(marker,i))continue;const end=markerEnd(text,marker,i+marker.length);if(end<=i+marker.length)continue;const inner=text.slice(i+marker.length,end);if(/^\s|\s$/.test(inner))continue;out+=`<${tag}>${inline(inner,depth+1,citations)}</${tag}>`;i=end+marker.length;marked=true;break;}if(marked)continue;
  out+=escapeHtml(c);i++;
 }
 return out;
}
export const renderInline=(text,{citations}={})=>inline(String(text??''),0,citationMap(citations));

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
function signature(block){const {id,_raw,_signature,_lineStart,_lineEnd,...value}=block;return JSON.stringify(value);}
function remember(block,raw,start,end){block._raw=raw;block._lineStart=start;block._lineEnd=end;block._signature=signature(block);return block;}
export function parseNoteBlocks(markdown=''){
 const lines=String(markdown).split('\n'),blocks=[];
 for(let i=0;i<lines.length;i++){
  const start=i,line=lines[i];let type='paragraph',text=line,checked=false,language='';
  const code=/^(`{3,}|~{3,})([^\n]*)$/.exec(line);if(code){language=code[2];const body=[];let closed=false;while(++i<lines.length){if(new RegExp('^'+code[1][0]+'{'+code[1].length+',}\\s*$').test(lines[i])){closed=true;break;}body.push(lines[i]);}i=Math.min(i,lines.length-1);blocks.push(remember({id:uid(),type:'code',text:body.join('\n'),language},lines.slice(start,i+1).join('\n'),start,i));continue;}
  const toggle=/^(:{3,})toggle(?: \[(open|closed)\])?(?: (.*))?$/.exec(line);if(toggle){const body=[];let end=i+1;while(end<lines.length&&lines[end]!==toggle[1])body.push(lines[end++]);if(end<lines.length){i=end;blocks.push(remember({id:uid(),type:'toggle',title:toggle[3]||'Toggle',text:body.join('\n'),open:toggle[2]==='open'},lines.slice(start,i+1).join('\n'),start,i));continue;}}
  if(i+1<lines.length&&line.includes('|')&&isTableDivider(lines[i+1])){const headers=splitTableRow(line),separator=splitTableRow(lines[i+1]);if(headers.length===separator.length){const rows=[];i++;while(i+1<lines.length&&lines[i+1].trim()&&!/^\s*(?:>|#{1,6}\s|`{3,}|~{3,}|:{3,}|[-*+]\s|\d+\.\s)/.test(lines[i+1])&&!/^\s*([-*_])\1\1+\s*$/.test(lines[i+1]))rows.push(splitTableRow(lines[++i]));blocks.push(remember(createTableBlock({headers,rows,alignments:separator.map(alignment)}),lines.slice(start,i+1).join('\n'),start,i));continue;}}
  if(/^---\s*$/.test(line)){type='divider';text='';}
  else if(/^### /.test(line)){type='h3';text=line.slice(4);}
  else if(/^## /.test(line)){type='h2';text=line.slice(3);}
  else if(/^# /.test(line)){type='h1';text=line.slice(2);}
  else if(/^[-*] \[[ x]\] /i.test(line)){type='todo';checked=/\[x\]/i.test(line);text=line.slice(6);}
  else if(/^[-*] /.test(line)){type='bullet';text=line.slice(2);}
  else if(/^\d+\. /.test(line)){type='number';text=line.replace(/^\d+\. /,'');}
  else if(/^> \[!NOTE\] /.test(line)){type='callout';text=line.slice(10);}
  else if(/^> /.test(line)){type='quote';text=line.slice(2);}
  const ordinal=type==='number'?Number(line.match(/^\d+/)[0]):undefined;
  blocks.push(remember({id:uid(),type,text,checked,language,...(type==='number'?{ordinal:Number.isSafeInteger(ordinal)?ordinal:1}:{})},line,start,i));
 }
 return blocks.length?blocks:[{id:uid(),type:'paragraph',text:''}];
}
export function serializeNoteBlocks(blocks){
 let number=0,numbered=false;
 return blocks.map(b=>{
  if(b.type==='number'){number=numbered?number+1:(Number.isSafeInteger(b.ordinal)?b.ordinal:1);numbered=true;}else{number=0;numbered=false;}
  if(typeof b._raw==='string'&&b._signature===signature(b))return b._raw;
  const prefixes={h1:'# ',h2:'## ',h3:'### ',bullet:'- ',todo:b.checked?'- [x] ':'- [ ] ',quote:'> ',callout:'> [!NOTE] ',paragraph:''};
  if(b.type==='table')return serializeTable(b);if(b.type==='toggle')return serializeToggle(b);if(b.type==='divider')return '---';
  if(b.type==='code'){let count=3;for(const line of String(b.text||'').split('\n')){const m=/^(`+)/.exec(line);if(m)count=Math.max(count,m[1].length+1);}const fence='`'.repeat(count);return fence+(b.language||'')+'\n'+b.text+'\n'+fence;}
  if(b.type==='number')return `${number}. ${b.text}`;return (prefixes[b.type]||'')+(b.text||'');
 }).join('\n');
}

function decodeCellPipes(text){return text.replace(/(\\+)\|/g,(full,slashes)=>slashes.length%2?'\\'.repeat(slashes.length-1)+'|':full);}
export function renderTableCell(value,options={}){const source=decodeCellPipes(String(value??''));let out='',chunk='',code='';for(let i=0;i<source.length;i++){if(source[i]==='`'&&(code||!escapedAt(source,i))){const run=source.slice(i).match(/^`+/)[0];if(code===run)code='';else if(!code&&codeEnd(source,run,i+run.length)>=0)code=run;chunk+=run;i+=run.length-1;continue;}const br=!code&&source.slice(i).match(/^<br\s*\/?>/i);if(br){out+=renderInline(chunk,options)+'<br>';chunk='';i+=br[0].length-1;continue;}if(source[i]==='\n'&&!code){out+=renderInline(chunk,options)+'<br>';chunk='';continue;}chunk+=source[i];}return out+renderInline(chunk,options);}
function renderTable(block,compact,options){const width=tableWidth(block),align=i=>['left','right','center'].includes(block.alignments?.[i])?` style="text-align:${block.alignments[i]}"`:'';return `<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${Array.from({length:width},(_,i)=>`<th scope="col"${align(i)}>${renderTableCell(block.headers[i]||'',options)}</th>`).join('')}</tr></thead><tbody>${(compact?block.rows.slice(0,3):block.rows).map(row=>'<tr>'+Array.from({length:width},(_,i)=>`<td${align(i)}>${renderTableCell(row[i]||'',options)}</td>`).join('')+'</tr>').join('')}</tbody></table></div>`;}
export function renderMarkdown(markdown,{interactiveTasks=false,compact=false,citations}={}){
 const sources=citationMap(citations),render=value=>inline(String(value??''),0,sources);
 const source=String(markdown??''),taskIndices=[];let task=0;for(const line of source.split('\n')){taskIndices.push(/^[-*] \[[ x]\]/i.test(line)?task++:null);}
 const draw=(text,offset=0,depth=0)=>{if(depth>16)return '<p>'+escapeHtml(text)+'</p>';const blocks=parseNoteBlocks(text),rows=compact?blocks.slice(0,12):blocks;let out='',list=null;
  const endList=()=>{if(list){out+='</'+list+'>';list=null;}};
  for(const b of rows){
   if(['bullet','number'].includes(b.type)){const kind=b.type==='number'?'ol':'ul';if(list!==kind){endList();out+='<'+kind+(kind==='ol'&&Number.isSafeInteger(b.ordinal)&&b.ordinal!==1?` start="${b.ordinal}"`:'')+'>';list=kind;}out+='<li>'+render(b.text)+'</li>';continue;}endList();
   if(b.type==='table'){out+=renderTable(b,compact,{citations});continue;}
   if(b.type==='toggle'){out+=`<details class="markdown-toggle"${b.open&&!compact?' open':''}><summary>${render(b.title)}</summary><div>${draw(b.text,offset+b._lineStart+1,depth+1)}</div></details>`;continue;}
   if(b.type==='code'){out+=`<pre class="markdown-code"><code${b.language?` data-language="${escapeHtml(b.language.trim())}"`:''}>${escapeHtml(b.text)}</code></pre>`;continue;}
   if(['h1','h2','h3'].includes(b.type)){const tag=compact?'h3':b.type;out+=`<${tag}>${render(b.text)}</${tag}>`;continue;}
   if(b.type==='divider'){out+='<hr class="markdown-divider">';continue;}
   if(b.type==='quote'){out+='<blockquote>'+render(b.text)+'</blockquote>';continue;}
   if(b.type==='callout'){out+='<aside class="markdown-callout"><span aria-hidden="true">✦</span><div>'+render(b.text)+'</div></aside>';continue;}
   if(b.type==='todo'){const index=taskIndices[offset+b._lineStart],label=escapeHtml(b.text);out+=`<div class="task-line ${b.checked?'done':''}">${interactiveTasks&&index!==null&&index!==undefined?`<input type="checkbox" data-task-index="${index}"${b.checked?' checked':''} aria-label="${label}">`:`<span class="task-check ${b.checked?'checked':''}" aria-hidden="true">${b.checked?'✓':''}</span>`}<span>${render(b.text)}</span></div>`;continue;}
   out+=b.text.trim()?'<p>'+render(b.text)+'</p>':'<div class="paragraph-space"></div>';
  }endList();return out;
 };
 return draw(source);
}
