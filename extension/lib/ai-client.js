import { requestBridge } from './integrations.js';
const SETTINGS_KEY='still.ai.preferences.v1',CHATS_KEY='still.ai.chats.v1';
async function readLocal(key,fallback){if(globalThis.chrome?.storage?.local)return (await chrome.storage.local.get(key))[key]??fallback;const raw=globalThis.localStorage?.getItem(key);if(!raw)return fallback;try{return JSON.parse(raw);}catch{throw new Error('Saved AI history is unreadable. Export it before replacing it.');}}
async function writeLocal(key,value){if(globalThis.chrome?.storage?.local)await chrome.storage.local.set({[key]:value});else if(globalThis.localStorage)localStorage.setItem(key,JSON.stringify(value));}
export function createAiClient({transport=requestBridge}={}){
 return {
  configuration:()=>transport('/ai/providers'),
  saveProvider:provider=>transport('/ai/providers',{method:'POST',body:provider}),
  deleteProvider:id=>transport('/ai/providers/'+encodeURIComponent(id),{method:'DELETE'}),
  testProvider:id=>transport('/ai/providers/'+encodeURIComponent(id)+'/test',{method:'POST',body:{}}),
  models:id=>transport('/ai/providers/'+encodeURIComponent(id)+'/models'),
  generate:(body,{signal,onEvent}={})=>transport('/ai/chat',{method:'POST',body,signal,onEvent}),
  authStatus:()=>transport('/ai/cli/auth'),
  startCodexLogin:()=>transport('/ai/cli/login',{method:'POST',body:{}}),
  loginStatus:id=>transport('/ai/cli/login/'+encodeURIComponent(id)),
  cancelLogin:id=>transport('/ai/cli/login/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:{}}),
  connections:()=>transport('/connections'),
  previewConnection:client=>transport('/connections/'+encodeURIComponent(client)+'/preview',{method:'POST',body:{}}),
  connect:(client,previewHash)=>transport('/connections/'+encodeURIComponent(client)+'/connect',{method:'POST',body:{previewHash}}),
  disconnect:(client,previewHash)=>transport('/connections/'+encodeURIComponent(client)+'/disconnect',{method:'POST',body:{previewHash}}),
  installSkills:client=>transport('/connections/'+encodeURIComponent(client)+'/skills',{method:'POST',body:{}}),
  preferences:()=>readLocal(SETTINGS_KEY,{providerId:'',model:'',reasoningEffort:'',tone:'natural',depth:'balanced',scope:'selected'}),
  savePreferences:value=>writeLocal(SETTINGS_KEY,value),
  chats:()=>readLocal(CHATS_KEY,[]),
  saveChats:async chats=>{if(!Array.isArray(chats)||chats.length>200||JSON.stringify(chats).length>8*1024*1024)throw new Error('AI history is full. Export or remove an older conversation before saving more.');await writeLocal(CHATS_KEY,chats);},
 };
}
