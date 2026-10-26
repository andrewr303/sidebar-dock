import test from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryStore} from '../extension/lib/store.js';
test('stale UI or agent edits cannot overwrite a newer note and tag batch changes are atomic',async()=>{
 let data=null;const s=createLibraryStore({read:async()=>data,write:async value=>{data=value;}});
 const first=await s.dispatch('saveItem',[{type:'note',title:'Shared',content:'Original',tags:['design']}]);
 const changed=await s.dispatch('updateItem',[first.id,{content:'A newer thought'},{expectedUpdatedAt:first.updatedAt}]);
 assert.notEqual(first.updatedAt,changed.updatedAt);
 await assert.rejects(s.dispatch('updateItem',[first.id,{content:'Stale'},{expectedUpdatedAt:first.updatedAt}]),/Conflict/);
 assert.equal(data.items[0].content,'A newer thought');
 const before=data.updatedAt;await s.dispatch('mutateTags',[{oldTag:'design',newTag:'ideas',expectedLibraryUpdatedAt:before}]);
 assert.deepEqual(data.items[0].tags,['ideas']);
 await assert.rejects(s.dispatch('mutateTags',[{oldTag:'ideas',newTag:null,expectedLibraryUpdatedAt:before}]),/Conflict/);
 assert.deepEqual(data.items[0].tags,['ideas']);
});
