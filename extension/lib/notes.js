// Pure note utilities (SPEC §6.3). Node-importable: no DOM or chrome access.
// Task indices follow the shared TASK_LINE rule from markdown.js, so an index from extractTasks is the same
// number the rendered checkbox carries in data-task-index, and toggleTask rewrites exactly that line.
import {parseNoteBlocks,plainText,inlineText,taskLineIndices,TASK_LINE} from './markdown.js';
import {canonicalUrl} from './store.js';

const WIKI=/\[\[([^[\]\n|]{1,200})(?:\|([^[\]\n]{1,200}))?\]\]/g;
function walkBlocks(markdown,visit){
 const walk=(text,offset,depth)=>{if(depth>16)return;for(const b of parseNoteBlocks(text)){visit(b,offset+(b._lineStart||0));if(b.type==='toggle')walk(b.text,offset+(b._lineStart||0)+1,depth+1);}};
 walk(String(markdown??''),0,0);
}

/** Real to-do blocks, in document order: { index, text (inline Markdown), plain, done, line (0-based), indent }. */
export function extractTasks(markdown){
 const indices=taskLineIndices(markdown),tasks=[];
 walkBlocks(markdown,(b,line)=>{const index=indices[line];if(b.type==='todo'&&index!==null&&index!==undefined)tasks.push({index,text:b.text,plain:inlineText(b.text),done:!!b.checked,line,indent:b.indent||0});});
 return tasks;
}
/** Sets (or, without `done`, flips) the checkbox of the task line with this index. Other bytes stay unchanged. */
export function toggleTask(markdown,index,done){
 const source=String(markdown??''),lines=source.split('\n');let next=0;
 for(let i=0;i<lines.length;i++){
  if(!TASK_LINE.test(lines[i]))continue;
  if(next++!==index)continue;
  const m=/^([ \t]*[-*] \[)([ xX])\]/.exec(lines[i]),checked=done===undefined?m[2]===' ':!!done;
  lines[i]=m[1]+(checked?(m[2]===' '?'x':m[2]):' ')+lines[i].slice(m[0].length-1);
  return lines.join('\n');
 }
 return source;
}
export function taskProgress(markdown){const tasks=extractTasks(markdown);return {done:tasks.filter(t=>t.done).length,total:tasks.length};}

/** Distinct [[wiki link]], ![[embed]] and [[page]]{page} targets (the part before "|"), outside code. */
export function extractWikiLinks(markdown){
 const seen=new Set();
 const scan=text=>{for(const m of String(text??'').replace(/(`+)[\s\S]*?\1/g,' ').replace(/\\\[/g,'  ').matchAll(WIKI)){const target=m[1].trim();if(target)seen.add(target);}};
 walkBlocks(markdown,b=>{if(b.type==='code'||b.type==='divider')return;if(b.type==='embed'||b.type==='page'){if(b.target)seen.add(b.target);return;}if(b.type==='table'){for(const row of [b.headers,...b.rows])row.forEach(scan);return;}scan(b.type==='toggle'?b.title:b.text);});
 return [...seen];
}
const usable=item=>item&&!item.deletedAt;
const newestFirst=(a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''));
/** Returns resolveLink for renderMarkdown/mountBlockEditor: matches an id first, then a title (notes first, newest first). */
export function linkResolver(items){
 const byId=new Map(),byTitle=new Map();
 for(const item of (Array.isArray(items)?items:[]).filter(usable).sort((a,b)=>(a.type==='note'?0:1)-(b.type==='note'?0:1)||newestFirst(a,b))){
  byId.set(String(item.id),item);const key=String(item.title||'').trim().toLowerCase();if(key&&!byTitle.has(key))byTitle.set(key,item);
 }
 return target=>{const key=String(target??'').trim(),item=byId.get(key)||byTitle.get(key.toLowerCase());return item?{id:item.id,title:item.title||'Untitled',type:item.type}:null;};
}
export function resolveWikiLinks(markdown,items){const resolve=linkResolver(items);return extractWikiLinks(markdown).map(title=>({title,id:resolve(title)?.id??null}));}

const collapse=text=>String(text).replace(/\s+/g,' ').trim();
function clip(text,max){if(text.length<=max)return text;const cut=text.slice(0,max),space=cut.lastIndexOf(' ');return (space>max*0.6?cut.slice(0,space):cut).replace(/[\s.,;:!?-]+$/,'')+'…';}
/** First ~max characters of the rendered text, for item.excerpt and card descriptions. */
export function noteExcerpt(markdown,max=180){return clip(collapse(plainText(markdown)),max);}
/** The first heading, or the first non-empty line, as plain text ('' for an empty note). */
export function noteTitleFromContent(markdown){
 let title='';
 walkBlocks(markdown,b=>{if(title||['code','divider','table'].includes(b.type))return;title=collapse(b.type==='toggle'?inlineText(b.title):inlineText(b.text));});
 return clip(title,80);
}
export function outline(markdown){const out=[];walkBlocks(markdown,(b,line)=>{if(/^h[1-3]$/.test(b.type)){const text=collapse(inlineText(b.text));if(text)out.push({level:Number(b.type[1]),text,line});}});return out;}
const CJK=/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/gu;
export function wordCount(markdown){const text=plainText(markdown),cjk=(text.match(CJK)||[]).length;return cjk+(text.replace(CJK,' ').match(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu)||[]).length;}

const canonical=url=>{try{return canonicalUrl(url);}catch{return '';}};
/** Notes about a page (canonical URL match), pinned first, then most recently updated. */
export function notesForPage(items,url){
 const target=canonical(url);if(!target)return [];
 return (Array.isArray(items)?items:[]).filter(item=>usable(item)&&item.type==='note'&&item.url&&canonical(item.url)===target).sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0)||newestFirst(a,b));
}

export function dailyNoteTitle(date=new Date(),locale='en-US'){
 let value=date instanceof Date?date:new Date(date??Date.now());if(Number.isNaN(value.getTime()))value=new Date();
 try{return new Intl.DateTimeFormat(locale||undefined,{weekday:'short',month:'short',day:'numeric',year:'numeric'}).format(value);}
 catch{return new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'}).format(value);}
}
/** Templates for "New note". `page` ({ url, title }) fills the reading-notes template. */
export function noteTemplates(now=new Date(),{page,locale}={}){
 const day=dailyNoteTitle(now,locale),url=String(page?.url||''),pageTitle=collapse(page?.title||'');
 return [
  {id:'blank',label:'Blank',title:'',content:''},
  {id:'daily',label:'Daily note',title:day,content:'## Focus\n\n- [ ] \n\n## Notes\n\n'},
  {id:'meeting',label:'Meeting notes',title:`Meeting notes, ${day}`,content:'## Attendees\n\n- \n\n## Agenda\n\n1. \n\n## Notes\n\n\n\n## Decisions\n\n- \n\n## Action items\n\n- [ ] '},
  {id:'reading',label:'Reading notes',title:pageTitle?`Notes on ${pageTitle}`:'Reading notes',url,content:`${url?`Source: ${url}\n\n`:''}## Summary\n\n\n\n## Key ideas\n\n- \n\n## Quotes\n\n> \n\n## Questions\n\n- `},
  {id:'project',label:'Project brief',title:'Project brief',content:'## Goal\n\n\n\n## Context\n\n\n\n## Scope\n\n- \n\n## Milestones\n\n- [ ] \n\n## Open questions\n\n- '}
 ];
}
