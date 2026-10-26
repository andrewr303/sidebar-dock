import {
 escapeHtml as esc, safeMarkdownUrl, renderInline, renderTableCell, renderMarkdown,
 parseNoteBlocks, serializeNoteBlocks, createTableBlock, createToggleBlock,
 tableWidth, insertTableRow, removeTableRow, insertTableColumn, removeTableColumn, tableCellPosition
} from './markdown.js';

const uid=()=>globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2);
export const BLOCK_COMMANDS=[
 ['paragraph','Text','Just start writing.','T'],
 ['h1','Heading 1','A big idea.','H₁'],
 ['h2','Heading 2','Give a thought some structure.','H₂'],
 ['h3','Heading 3','A smaller heading.','H₃'],
 ['bullet','Bulleted list','Keep a few things together.','•'],
 ['number','Numbered list','One thing after another.','1.'],
 ['todo','To-do list','Something worth doing.','☑'],
 ['toggle','Toggle list','Fold a thought, keep the detail.','▸'],
 ['quote','Quote','Words worth keeping.','“'],
 ['callout','Callout','Let an idea stand out.','✦'],
 ['table','Table','Compare ideas in editable rows and columns.','▦'],
 ['link','Link','Connect a page without leaving your note.','↗'],
 ['image','Image link','Keep an image as a link you choose to open.','▧'],
 ['file','File link','Reference a file by its web address.','⌁'],
 ['code','Code','A little technical detail.','</>'],
 ['divider','Divider','A little breathing room.','―']
];
const aliases={paragraph:['text','plain'],h1:['heading1','title'],h2:['heading2','subtitle'],h3:['heading3'],bullet:['ul','unordered','bullets'],number:['ol','ordered','numbered'],todo:['task','tasks','checklist','checkbox'],toggle:['collapse','collapsible','details','fold'],table:['grid','rows','columns','spreadsheet'],link:['url','bookmark','reference'],image:['picture','photo','media'],file:['attachment','document','pdf'],code:['fence','snippet'],divider:['hr','separator','line']};
const normalize=value=>String(value).toLowerCase().replace(/[\s_\-/]+/g,'');
export function findBlockCommands(query=''){
 const terms=String(query).replace(/^\//,'').trim().split(/\s+/).map(normalize).filter(Boolean);
 return BLOCK_COMMANDS.filter(command=>terms.every(q=>[command[0],command[1],...(aliases[command[0]]||[])].some(value=>normalize(value).includes(q))));
}
export const parseMarkdown=parseNoteBlocks;
export const serializeBlocks=serializeNoteBlocks;
function fromChildren(node){return [...node.childNodes].map(fromNode).join('');}
function emphasize(text,marker){const leading=text.match(/^\s*/)[0],trailing=text.match(/\s*$/)[0],content=text.slice(leading.length,text.length-trailing.length);return content?leading+marker+content+marker+trailing:text;}
function codeSpan(text){if(!text)return '';const runs=text.match(/`+/g)||[],fence='`'.repeat(Math.max(0,...runs.map(s=>s.length))+1),padding=text.startsWith('`')||text.endsWith('`')||(/^ .* $/.test(text)&&text.trim())?' ':'';return fence+padding+text+padding+fence;}
function linkLabel(text){return text.replace(/([\[\]\\])/g,'\\$1');}
function linkMarkdown(label,url,image=false){return `${image?'!':''}[${linkLabel(label)}](<${url}>)`;}
function fromNode(node){
 if(node.nodeType===3)return node.textContent;if(node.nodeType===11)return fromChildren(node);if(node.nodeType!==1)return '';
 const t=fromChildren(node);
 if(['STRONG','B'].includes(node.tagName))return emphasize(t,'**');
 if(['EM','I'].includes(node.tagName))return emphasize(t,'*');
 if(['S','DEL'].includes(node.tagName))return emphasize(t,'~~');
 if(node.tagName==='CODE')return codeSpan(t);
 if(node.tagName==='A'){const href=safeMarkdownUrl(node.getAttribute?.('href')),image=(node.getAttribute?.('class')||'').split(/\s+/).includes('markdown-media-link'),label=image?[...node.childNodes].slice(1).map(fromNode).join(''):t;return href?linkMarkdown(label||href,href,image):t;}
 if(node.tagName==='BR')return '\n';if(node.tagName==='DIV')return '\n'+t;return t;
}
export function serializeInlineFragment(fragment){return fromNode(fragment);}

// Table cells reveal Markdown while editing and show a safe preview on blur.
// Cell newlines serialize as <br>. Toggle bodies are portable Markdown too.
export function mountBlockEditor(textarea,{onAskAi=()=>{},onChange=()=>{}}={}){
 let blocks=parseMarkdown(textarea.value),activeId=blocks[0].id,activeCell=null,slashId=null,slashIndex=0,undo=[],redo=[],lastSnapshot=textarea.value,setting=false,linkTarget=null;
 const editingToggles=new Set(),baselines=new WeakMap();
 const root=document.createElement('div');root.className='notion-editor';
 root.innerHTML='<div class="block-editor-toolbar"><span>Write, collect, connect.</span><button type="button" data-editor-action="ai">✳ Ask AI</button><button type="button" data-editor-action="undo" title="Undo" aria-label="Undo block edit">↶</button><button type="button" data-editor-action="redo" title="Redo" aria-label="Redo block edit">↷</button><button type="button" data-editor-action="markdown">Markdown</button></div><div class="rich-block-error" role="status" aria-live="polite"></div><div class="block-list" role="group" aria-label="Note blocks"></div><div class="block-slash-menu" hidden role="menu" aria-label="Block types"></div><div class="block-link-popover" hidden role="group" aria-label="Insert a reference"><strong data-link-title>Add a link</strong><label>Label<input data-link-label type="text" maxlength="500" placeholder="A useful reference"></label><label>Web address<input data-link-url type="url" placeholder="https://example.com" autocomplete="off"></label><p>References open only when you choose them.</p><div><button type="button" data-editor-action="cancel-link">Cancel</button><button type="button" data-editor-action="insert-link">Insert link</button></div></div><div class="block-editor-foot"><span>Type <kbd>/</kbd> for blocks · Select text to format</span><button type="button" data-editor-action="append">＋ Add a block</button></div>';
 textarea.before(root);textarea.hidden=true;textarea.classList.add('notion-source');
 const list=root.querySelector('.block-list'),menu=root.querySelector('.block-slash-menu'),linkPopover=root.querySelector('.block-link-popover'),error=root.querySelector('.rich-block-error');
 const block=id=>blocks.find(b=>b.id===id);
 const report=message=>{error.textContent=message||'';};
 function record(){const value=serializeBlocks(blocks);if(value===lastSnapshot)return;undo.push(lastSnapshot);if(undo.length>60)undo.shift();redo=[];lastSnapshot=value;}
 function emit(){setting=true;try{textarea.value=serializeBlocks(blocks);textarea.dispatchEvent(new Event('input',{bubbles:true}));}finally{setting=false;}onChange(textarea.value);}
 function sync(){record();emit();}
 function contentNode(id){const container=[...list.querySelectorAll('[data-block-id]')].find(e=>e.dataset.blockId===id);return container?.querySelector('[data-block-edit], [data-table-cell], [data-toggle-title]');}
 function focus(id,end=true,cell=null){
  const container=[...list.querySelectorAll('[data-block-id]')].find(e=>e.dataset.blockId===id);
  const el=cell?container?.querySelector(`[data-cell-row="${cell.row}"][data-cell-column="${cell.column}"]`):contentNode(id);if(!el)return;
  activeId=id;el.focus();if(el.matches('input,textarea')){const position=end?el.value.length:0;el.setSelectionRange(position,position);return;}
  const range=document.createRange();range.selectNodeContents(el);range.collapse(!end);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
 }
 function tableMarkup(b){
  const width=tableWidth(b),cell=(value,row,column)=>`<${row<0?'th scope="col"':'td'}><div contenteditable="true" role="textbox" aria-multiline="true" aria-label="${row<0?'Header':`Row ${row+1},`} column ${column+1}; Markdown" data-table-cell="${b.id}" data-cell-row="${row}" data-cell-column="${column}" spellcheck="true">${renderTableCell(value||'')}</div></${row<0?'th':'td'}>`;
  return `<div class="rich-table" role="group" aria-label="Editable table"><div class="rich-table-tools" role="toolbar" aria-label="Table controls"><button type="button" data-table-action="add-row" data-table-id="${b.id}">＋ Row</button><button type="button" data-table-action="add-column" data-table-id="${b.id}">＋ Column</button><button type="button" data-table-action="remove-row" data-table-id="${b.id}" ${b.rows.length?'':'disabled'}>− Row</button><button type="button" data-table-action="remove-column" data-table-id="${b.id}" ${width===1?'disabled':''}>− Column</button></div><div class="rich-table-scroll"><table><thead><tr>${Array.from({length:width},(_,i)=>cell(b.headers[i],-1,i)).join('')}</tr></thead><tbody>${b.rows.map((row,r)=>'<tr>'+Array.from({length:width},(_,c)=>cell(row[c],r,c)).join('')+'</tr>').join('')}</tbody></table></div><p class="rich-block-hint">Cells support Markdown · Tab / Enter moves · Shift + Enter adds a line</p></div>`;
 }
 function toggleMarkup(b){const editing=editingToggles.has(b.id);return `<details class="rich-toggle" data-toggle-id="${b.id}" ${b.open?'open':''}><summary><input type="text" data-toggle-title="${b.id}" value="${esc(b.title)}" aria-label="Toggle title" placeholder="Toggle title"></summary><div class="rich-toggle-content"><div class="rich-toggle-tools"><button type="button" data-toggle-edit="${b.id}">${editing?'Preview content':'Edit content'}</button><span class="rich-block-hint">Markdown inside, detail on demand.</span></div>${editing?`<textarea data-toggle-body="${b.id}" aria-label="Toggle content in Markdown" spellcheck="true" rows="5">${esc(b.text)}</textarea>`:`<div class="rich-toggle-preview">${renderMarkdown(b.text)||'<p class="rich-block-hint">Add a little detail.</p>'}</div>`}</div></details>`;}
 function render(focusId,cell=null){
  let count=0,numbered=false;list.innerHTML=blocks.map(b=>{
   count=b.type==='number'?(numbered?count+1:(b.ordinal??1)):0;numbered=b.type==='number';
   const marker=b.type==='todo'?`<input type="checkbox" data-block-check="${b.id}" ${b.checked?'checked':''} aria-label="Complete ${esc(b.text||'task')}">`:b.type==='bullet'?'<span class="block-marker">•</span>':b.type==='number'?`<span class="block-marker">${count}.</span>`:b.type==='callout'?'<span class="block-marker">✦</span>':'';
   const content=b.type==='table'?tableMarkup(b):b.type==='toggle'?toggleMarkup(b):b.type==='divider'?'<hr tabindex="0" aria-label="Divider">':`<div class="block-editable ${b.checked?'checked':''}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${b.type==='paragraph'?'Text block':BLOCK_COMMANDS.find(c=>c[0]===b.type)?.[1]||'Note block'}" data-block-edit="${b.id}" data-placeholder="${b.type==='paragraph'?'Write something, or type / for blocks…':''}" spellcheck="${b.type==='code'?'false':'true'}">${b.type==='code'?esc(b.text):renderInline(b.text)}</div>`;
   return `<div class="note-block block-${b.type}" data-block-id="${b.id}" draggable="false"><div class="block-handles"><button type="button" data-block-add="${b.id}" aria-label="Insert a block after this block" title="Insert block">＋</button><button type="button" data-block-menu="${b.id}" draggable="true" data-block-drag="${b.id}" aria-label="Block options" title="Drag or change block">⠿</button></div>${marker}${content}</div>`;
  }).join('');
  for(const el of list.querySelectorAll('[data-block-edit]'))baselines.set(el,{html:el.innerHTML,text:block(el.dataset.blockEdit).text});
  if(focusId)focus(focusId,true,cell);
 }
 function readDom(){
  for(const el of list.querySelectorAll('[data-block-edit]')){const b=block(el.dataset.blockEdit),baseline=baselines.get(el);if(b)b.text=baseline?.html===el.innerHTML?baseline.text:b.type==='code'?el.innerText:[...el.childNodes].map(fromNode).join('').replace(/\n$/,'');}
  for(const el of list.querySelectorAll('[data-table-cell][data-source-editing="true"]')){const b=block(el.dataset.tableCell),baseline=baselines.get(el);if(b&&baseline?.html!==el.innerHTML){const row=Number(el.dataset.cellRow),column=Number(el.dataset.cellColumn);(row<0?b.headers:b.rows[row])[column]=el.innerText.replace(/\r\n?/g,'\n');}}
  for(const el of list.querySelectorAll('[data-toggle-title]')){const b=block(el.dataset.toggleTitle);if(b)b.title=el.value;}
  for(const el of list.querySelectorAll('[data-toggle-body]')){const b=block(el.dataset.toggleBody);if(b)b.text=el.value;}
 }
 function hideMenu(){slashId=null;menu.hidden=true;menu.innerHTML='';}
 function filteredCommands(){const b=block(slashId);return findBlockCommands(b?.type==='paragraph'&&b.text.startsWith('/')?b.text:'');}
 function showMenu(id,extra=false){
  slashId=id;const commands=filteredCommands();slashIndex=Math.min(slashIndex,Math.max(0,commands.length-1));menu.hidden=false;
  menu.innerHTML='<span class="slash-eyebrow">ADD TO YOUR NOTE</span>'+(commands.length?commands.map((c,i)=>`<button type="button" role="menuitem" class="${i===slashIndex?'active':''}" data-block-type="${c[0]}"><b aria-hidden="true">${c[3]}</b><span><strong>${c[1]}</strong><small>${c[2]}</small></span></button>`).join(''):'<p class="slash-empty">No matching blocks. Try “table”, “toggle”, or “link”.</p>')+(extra?'<div class="block-menu-divider"></div><button type="button" data-editor-action="duplicate">Duplicate block</button><button type="button" data-editor-action="move-up">Move up</button><button type="button" data-editor-action="move-down">Move down</button><button type="button" data-editor-action="delete">Delete block</button>':'');
  const el=list.querySelector(`[data-block-id="${id}"]`);if(el){const r=el.getBoundingClientRect(),base=root.getBoundingClientRect();menu.style.top=Math.min(r.bottom-base.top+4,Math.max(10,root.clientHeight-150))+'px';}
  menu.querySelector('.active')?.scrollIntoView({block:'nearest'});
 }
 function plainBlockText(b){return b.type==='table'?[b.headers,...b.rows].map(row=>row.join('\t')).join('\n'):b.type==='toggle'?[b.title,b.text].filter(Boolean).join('\n'):b.text;}
 function changeType(type){
  readDom();const b=block(slashId||activeId);if(!b)return;activeId=b.id;
  const text=b.type==='paragraph'&&b.text.startsWith('/')?'':plainBlockText(b);
  if(['link','image','file'].includes(type)){if(b.type==='paragraph'&&b.text.startsWith('/')){b.text='';sync();render(b.id);}hideMenu();openLink(type);return;}
  const next=type==='table'?createTableBlock({headers:text?[text,'Column 2']:undefined}):type==='toggle'?createToggleBlock({title:text||'Toggle',text:''}):{id:b.id,type,text,checked:b.checked||false,language:b.language||''};next.id=b.id;blocks[blocks.indexOf(b)]=next;
  if(type==='toggle')editingToggles.add(b.id);hideMenu();report('');sync();render(b.id);
 }
 function addAfter(id,type='paragraph'){readDom();const index=blocks.findIndex(b=>b.id===id),b={id:uid(),type,text:'',checked:false};blocks.splice(index+1,0,b);sync();render(b.id);return b;}
 function setMarkdown(value,{emit:shouldEmit=true}={}){blocks=parseMarkdown(value);activeId=blocks[0].id;activeCell=null;editingToggles.clear();hideMenu();linkPopover.hidden=true;report('');if(shouldEmit)sync();else lastSnapshot=String(value);render();}
 function selectionText(){const el=document.activeElement;if(root.contains(el)&&el.matches('input,textarea'))return el.value.slice(el.selectionStart,el.selectionEnd);const selection=getSelection();return selection&&root.contains(selection.anchorNode)?selection.toString():'';}
 function sourceSelection(el){const sel=getSelection();if(!sel.rangeCount)return null;const range=sel.getRangeAt(0);if(!el.contains(range.startContainer)||!el.contains(range.endContainer))return null;const prefix=range.cloneRange();prefix.selectNodeContents(el);prefix.setEnd(range.startContainer,range.startOffset);return {start:prefix.toString().length,end:prefix.toString().length+range.toString().length};}
 function replaceSource(el,text,{start,end}={}){const value=el.innerText,position=start??value.length;el.textContent=value.slice(0,position)+text+value.slice(end??position);const node=el.firstChild,range=document.createRange();if(node){range.setStart(node,Math.min(position+text.length,node.length));range.collapse(true);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);}readDom();sync();}
 function openLink(kind='link'){
  readDom();const el=document.activeElement,selection=getSelection();linkTarget={id:activeId,kind};
  if(root.contains(el)&&el.matches('[data-table-cell]'))linkTarget={...linkTarget,cell:{row:Number(el.dataset.cellRow),column:Number(el.dataset.cellColumn)},position:sourceSelection(el)};
  else if(root.contains(el)&&el.matches('[data-toggle-body]'))linkTarget={...linkTarget,body:true,position:{start:el.selectionStart,end:el.selectionEnd}};
  else if(selection.rangeCount&&root.contains(selection.anchorNode)){const range=selection.getRangeAt(0);if(range.startContainer===range.endContainer||range.commonAncestorContainer.closest?.('[data-block-edit]'))linkTarget.range=range.cloneRange();}
  root.querySelector('[data-link-title]').textContent=kind==='image'?'Add an image reference':kind==='file'?'Add a file reference':'Add a link';root.querySelector('[data-link-label]').value=selectionText();root.querySelector('[data-link-url]').value='';linkPopover.hidden=false;report('');root.querySelector('[data-link-url]').focus();
 }
 function insertLink(){
  const url=safeMarkdownUrl(root.querySelector('[data-link-url]').value);if(!url){report('Use an https:// or http:// address, a mailto: address, or a note #anchor.');root.querySelector('[data-link-url]').focus();return;}
  const target=linkTarget,b=target&&block(target.id);if(!b){linkPopover.hidden=true;return;}
  const label=root.querySelector('[data-link-label]').value.trim()||url,source=linkMarkdown(target.kind==='file'?'File: '+label:label,url,target.kind==='image');
  linkPopover.hidden=true;
  if(target.cell){focus(b.id,true,target.cell);replaceSource(document.activeElement,source,target.position||{});}
  else if(target.body){const el=list.querySelector(`[data-toggle-body="${b.id}"]`);if(el){const {start,end}=target.position;el.setRangeText(source,start,end,'end');el.focus();readDom();sync();}}
  else if(target.range?.startContainer.isConnected&&contentNode(b.id)?.contains(target.range.startContainer)&&contentNode(b.id)?.contains(target.range.endContainer)){
   const range=target.range;range.deleteContents();const fragment=document.createElement('span');fragment.innerHTML=renderInline(source);const node=fragment.firstChild;range.insertNode(node);range.setStartAfter(node);range.collapse(true);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);readDom();sync();
  }else{b.text+=(b.text?' ':'')+source;sync();render(b.id);}linkTarget=null;report('');
 }
 function command(type){
  const normalized={heading:'h2',task:'todo'}[type]||type;
  if(BLOCK_COMMANDS.some(c=>c[0]===normalized)){readDom();slashId=activeId;changeType(normalized);return;}
  if(!['bold','italic','code-inline'].includes(type))return;
  const el=document.activeElement,marker={bold:'**',italic:'*','code-inline':'`'}[type];
  if(root.contains(el)&&el.matches('[data-toggle-body]')){const start=el.selectionStart,end=el.selectionEnd;if(start===end)return;const selected=el.value.slice(start,end),formatted=type==='code-inline'?codeSpan(selected):emphasize(selected,marker);el.setRangeText(formatted,start,end,'select');readDom();sync();return;}
  if(root.contains(el)&&el.matches('[data-table-cell]')){const position=sourceSelection(el);if(!position||position.start===position.end)return;const selected=el.innerText.slice(position.start,position.end);replaceSource(el,type==='code-inline'?codeSpan(selected):emphasize(selected,marker),position);return;}
  const sel=getSelection();if(!sel.rangeCount||!root.contains(sel.anchorNode))return;const range=sel.getRangeAt(0),editable=sel.anchorNode.nodeType===1?sel.anchorNode.closest('[data-block-edit]'):sel.anchorNode.parentElement?.closest('[data-block-edit]');if(range.collapsed||!editable?.contains(range.endContainer)){report('Select text within one block to format it.');return;}
  const element=document.createElement(type==='bold'?'strong':type==='italic'?'em':'code');element.append(range.extractContents());range.insertNode(element);range.selectNodeContents(element);sel.removeAllRanges();sel.addRange(range);readDom();sync();
 }
 function tableAction(button){
  readDom();const b=block(button.dataset.tableId);if(!b)return;const cell=activeCell?.id===b.id?activeCell:{row:Math.max(0,b.rows.length-1),column:tableWidth(b)-1};let next,position={row:cell.row,column:cell.column};
  try{if(button.dataset.tableAction==='add-row'){const index=Math.min(b.rows.length,Math.max(0,cell.row+1));next=insertTableRow(b,index);position.row=index;}if(button.dataset.tableAction==='remove-row'){if(!b.rows.length)return;const index=Math.max(0,Math.min(b.rows.length-1,cell.row));next=removeTableRow(b,index);position.row=Math.min(index,next.rows.length-1);}if(button.dataset.tableAction==='add-column'){const index=cell.column+1;next=insertTableColumn(b,index);position.column=index;}if(button.dataset.tableAction==='remove-column'){next=removeTableColumn(b,cell.column);position.column=Math.min(cell.column,tableWidth(next)-1);}if(next){blocks[blocks.indexOf(b)]=next;activeId=b.id;report('');sync();render(b.id,position);}}catch(cause){report(cause.message);}
 }
 root.addEventListener('pointerdown',e=>{if(e.target.closest('button'))e.preventDefault();});
 root.addEventListener('input',e=>{
  if(e.target.closest('.block-link-popover'))return;
  const el=e.target.closest('[data-block-edit],[data-table-cell],[data-toggle-title],[data-toggle-body]');if(!el)return;activeId=el.dataset.blockEdit||el.dataset.tableCell||el.dataset.toggleTitle||el.dataset.toggleBody;readDom();sync();const b=block(activeId);if(b.type==='paragraph'&&/^\/[^\n]*$/.test(b.text)){slashIndex=0;showMenu(b.id);}else hideMenu();
 });
 root.addEventListener('focusin',e=>{
  const el=e.target;if(el.dataset.blockEdit)activeId=el.dataset.blockEdit;
  if(el.dataset.toggleTitle||el.dataset.toggleBody)activeId=el.dataset.toggleTitle||el.dataset.toggleBody;
  if(el.dataset.tableCell){activeId=el.dataset.tableCell;activeCell={id:activeId,row:Number(el.dataset.cellRow),column:Number(el.dataset.cellColumn)};if(el.dataset.sourceEditing!=='true'){const b=block(activeId);el.textContent=(activeCell.row<0?b.headers:b.rows[activeCell.row])[activeCell.column]||'';el.dataset.sourceEditing='true';baselines.set(el,{html:el.innerHTML});}}
 });
 root.addEventListener('focusout',e=>{const el=e.target;if(el.dataset.tableCell&&el.dataset.sourceEditing==='true'){readDom();const b=block(el.dataset.tableCell),row=Number(el.dataset.cellRow),column=Number(el.dataset.cellColumn);el.innerHTML=renderTableCell((row<0?b.headers:b.rows[row])[column]||'');delete el.dataset.sourceEditing;}});
 root.addEventListener('paste',e=>{
  const el=e.target.closest('[data-block-edit],[data-table-cell]');if(!el)return;e.preventDefault();const text=e.clipboardData.getData('text/plain');
  if(el.dataset.tableCell){replaceSource(el,text,sourceSelection(el)||{});return;}
  const sel=getSelection();if(!sel.rangeCount)return;const range=sel.getRangeAt(0);if(!el.contains(range.startContainer)||!el.contains(range.endContainer))return;range.deleteContents();const node=document.createTextNode(text);range.insertNode(node);range.setStartAfter(node);range.collapse(true);sel.removeAllRanges();sel.addRange(range);readDom();sync();
 });
 root.addEventListener('change',e=>{if(e.target.dataset.blockCheck){readDom();block(e.target.dataset.blockCheck).checked=e.target.checked;sync();render();}});
 root.addEventListener('toggle',e=>{const el=e.target;if(el.dataset.toggleId){const b=block(el.dataset.toggleId);if(b&&b.open!==el.open){readDom();b.open=el.open;sync();}}},true);
 root.addEventListener('click',e=>{
  const type=e.target.closest('[data-block-type]');if(type){changeType(type.dataset.blockType);return;}
  const tableButton=e.target.closest('[data-table-action]');if(tableButton){tableAction(tableButton);return;}
  const toggleButton=e.target.closest('[data-toggle-edit]');if(toggleButton){readDom();const id=toggleButton.dataset.toggleEdit;if(editingToggles.has(id))editingToggles.delete(id);else editingToggles.add(id);render();const el=list.querySelector(`[data-toggle-body="${id}"]`);el?.focus();return;}
  const add=e.target.closest('[data-block-add]');if(add){const b=addAfter(add.dataset.blockAdd);showMenu(b.id);return;}
  const handle=e.target.closest('[data-block-menu]');if(handle){activeId=handle.dataset.blockMenu;showMenu(activeId,true);return;}
  const action=e.target.closest('[data-editor-action]')?.dataset.editorAction;if(!action)return;
  if(action==='insert-link'){insertLink();return;}if(action==='cancel-link'){linkPopover.hidden=true;linkTarget=null;report('');focus(activeId);return;}
  readDom();const index=blocks.findIndex(b=>b.id===activeId);
  if(action==='ai'){onAskAi({selection:selectionText(),draft:serializeBlocks(blocks)});return;}
  if(action==='append'){addAfter(blocks.at(-1).id);return;}
  if(action==='markdown'){root.hidden=true;textarea.hidden=false;textarea.focus();return;}
  if(action==='undo'||action==='redo'){const source=action==='undo'?undo:redo,dest=action==='undo'?redo:undo;if(!source.length)return;dest.push(serializeBlocks(blocks));const value=source.pop();lastSnapshot=value;blocks=parseMarkdown(value);activeId=blocks[Math.min(Math.max(0,index),blocks.length-1)].id;hideMenu();emit();render();return;}
  if(index<0)return;
  if(action==='duplicate'){const copy=structuredClone(blocks[index]);copy.id=uid();blocks.splice(index+1,0,copy);}
  if(action==='delete'){blocks.splice(index,1);if(!blocks.length)blocks=parseMarkdown('');activeId=blocks[Math.min(index,blocks.length-1)].id;}
  if(action==='move-up'&&index>0)[blocks[index-1],blocks[index]]=[blocks[index],blocks[index-1]];
  if(action==='move-down'&&index<blocks.length-1)[blocks[index+1],blocks[index]]=[blocks[index],blocks[index+1]];
  hideMenu();sync();render();
 });
 root.addEventListener('keydown',e=>{
  if(e.target.closest('.block-link-popover')){if(e.key==='Enter'){e.preventDefault();e.stopPropagation();insertLink();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();linkPopover.hidden=true;linkTarget=null;report('');focus(activeId);}return;}
  const el=e.target.closest('[data-block-edit],[data-table-cell],[data-toggle-title],[data-toggle-body]');if(!el)return;
  if(!menu.hidden&&['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key)){e.preventDefault();e.stopPropagation();if(e.key==='Escape'){hideMenu();return;}const commands=filteredCommands();if(e.key==='Enter'){if(commands[slashIndex])changeType(commands[slashIndex][0]);return;}if(commands.length){slashIndex=(slashIndex+(e.key==='ArrowDown'?1:-1)+commands.length)%commands.length;showMenu(slashId);}return;}
  if((e.ctrlKey||e.metaKey)&&['b','i','e'].includes(e.key.toLowerCase())){e.preventDefault();command({b:'bold',i:'italic',e:'code-inline'}[e.key.toLowerCase()]);return;}
  if((e.ctrlKey||e.metaKey)&&e.key==='Enter')return;
  if(el.dataset.tableCell&&['Tab','Enter'].includes(e.key)){
   if(e.key==='Enter'&&e.shiftKey){e.preventDefault();replaceSource(el,'\n',sourceSelection(el)||{});return;}
   readDom();const b=block(el.dataset.tableCell),position=tableCellPosition(b,{row:Number(el.dataset.cellRow),column:Number(el.dataset.cellColumn)},e.key,{shift:e.shiftKey});if(position.leave)return;e.preventDefault();e.stopPropagation();if(position.appendRow){blocks[blocks.indexOf(b)]=insertTableRow(b);sync();render(b.id,position);}else focus(b.id,true,position);return;
  }
  if(el.dataset.toggleTitle&&e.key==='Enter'){e.preventDefault();const b=block(el.dataset.toggleTitle);readDom();b.open=true;editingToggles.add(b.id);sync();render();list.querySelector(`[data-toggle-body="${b.id}"]`)?.focus();return;}
  if(!el.dataset.blockEdit)return;
  if(e.key==='Enter'&&!e.shiftKey){
   readDom();const b=block(el.dataset.blockEdit);if(b.type==='code')return;e.preventDefault();if(['bullet','number','todo'].includes(b.type)&&!b.text){b.type='paragraph';sync();render(b.id);return;}
   const sel=getSelection(),range=sel.rangeCount?sel.getRangeAt(0):null;let rest='';
   if(range&&el.contains(range.startContainer)&&el.contains(range.endContainer)){
    const prefix=document.createRange(),suffix=document.createRange();prefix.selectNodeContents(el);prefix.setEnd(range.startContainer,range.startOffset);suffix.selectNodeContents(el);suffix.setStart(range.endContainer,range.endOffset);b.text=serializeInlineFragment(prefix.cloneContents());rest=serializeInlineFragment(suffix.cloneContents());
   }
   const next={id:uid(),type:['bullet','number','todo'].includes(b.type)?b.type:'paragraph',text:rest,checked:false};blocks.splice(blocks.indexOf(b)+1,0,next);sync();render(next.id);focus(next.id,false);return;
  }
  if(e.key==='Backspace'){
   const sel=getSelection();if(sel.rangeCount&&!sel.toString()){const range=sel.getRangeAt(0);if(!el.contains(range.startContainer))return;const prefix=range.cloneRange();prefix.selectNodeContents(el);prefix.setEnd(range.startContainer,range.startOffset);if(!prefix.toString().length){readDom();const index=blocks.findIndex(b=>b.id===el.dataset.blockEdit),previous=blocks[index-1];if(previous&&!['table','toggle','divider'].includes(previous.type)){e.preventDefault();previous.text+=blocks[index].text;blocks.splice(index,1);sync();render(previous.id);}}}
  }
 });
 root.addEventListener('dragstart',e=>{const id=e.target.dataset.blockDrag;if(id){e.dataTransfer.setData('application/x-still-block',id);e.dataTransfer.effectAllowed='move';e.stopPropagation();}});
 root.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('application/x-still-block'))e.preventDefault();});
 root.addEventListener('drop',e=>{const id=e.dataTransfer.getData('application/x-still-block'),target=e.target.closest('[data-block-id]')?.dataset.blockId;if(!id||!target||id===target)return;e.preventDefault();e.stopPropagation();readDom();const index=blocks.findIndex(b=>b.id===id);if(index<0)return;const [moved]=blocks.splice(index,1);blocks.splice(blocks.findIndex(b=>b.id===target)+1,0,moved);sync();render(moved.id);});
 const external=()=>{if(!setting){blocks=parseMarkdown(textarea.value);lastSnapshot=textarea.value;activeId=blocks[0].id;hideMenu();linkPopover.hidden=true;render();}};textarea.addEventListener('input',external);
 render();
 return {root,getMarkdown:()=>{readDom();return serializeBlocks(blocks);},setMarkdown,getSelection:selectionText,command,focus:()=>focus(activeId),show:()=>{root.hidden=false;textarea.hidden=true;external();},destroy:()=>{textarea.removeEventListener('input',external);root.remove();textarea.classList.remove('notion-source');textarea.hidden=false;}};
}
