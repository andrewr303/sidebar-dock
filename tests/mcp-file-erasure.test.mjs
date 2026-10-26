import test from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryStore} from '../extension/lib/store.js';
import {createIntegrationClient} from '../extension/lib/integrations.js';
import {createBridgeState} from '../bridge/protocol.mjs';
for(const failCleanup of [false,true])test(`permanent MCP deletion reports applied metadata and ${failCleanup?'a file-cleanup warning':'original-file cleanup'}`,async()=>{
 let state=null,removed=0;
 const queue=createLibraryStore({read:async()=>state,write:async v=>{state=v;}});
 const item=await queue.dispatch('saveItem',[{type:'file',title:'Original file',attachmentId:'private-file',fileName:'original.bin',mime:'application/octet-stream'}]);
 const store={loadLibrary:()=>queue.dispatch('loadLibrary',[]),deleteItem:(id,o)=>queue.dispatch('deleteItem',[id,o]),permanentlyDeleteItem:(id,o)=>queue.dispatch('permanentlyDeleteItem',[id,o]),deleteAttachment:async()=>{removed++;if(failCleanup)throw new Error('Device I/O failed');}};
 const bridge=createBridgeState();
 const client=createIntegrationClient({store,storage:{read:async()=>({bridgeEnabled:true,bridgeToken:'fixture-token-over-24-characters',bridgeUrl:'http://127.0.0.1:43123'}),write:async()=>{}},fetch:async(_url,options)=>Response.json(bridge.sync(JSON.parse(options.body)))});
 await client.syncBridgeOnce();bridge.callTool('trash_item',{id:item.id});await client.syncBridgeOnce();
 const operation=bridge.callTool('permanently_delete_item',{id:item.id,confirm:true});await client.syncBridgeOnce();
 const receipt=bridge.callTool('get_operation',{id:operation.id});assert.equal(receipt.status,'saved');assert.equal(state.items.length,0);assert.equal(removed,1);assert.equal(receipt.result.fileCleanup,failCleanup?'failed':'complete');if(failCleanup)assert.match(receipt.result.warning,/permanently deleted.*could not be removed/);
});
