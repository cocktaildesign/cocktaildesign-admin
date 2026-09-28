const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{randomUUID}=require('node:crypto');
const load=()=>import(pathToFileURL(path.resolve(__dirname,'../ops/feedback-worker/orders.mjs')).href);
function fixture(){
 const item={id:1,requestId:randomUUID(),leaseToken:randomUUID(),leaseExpiresAt:new Date(Date.now()+1800000).toISOString(),messages:['<b>Заказ</b> · 1/2\nТовары','<b>Заказ</b> · 2/2\nИтог']};
 const receipts=new Map(),calls=[],state={ackFails:false,part2Fails:false,verified:true,stopping:false};let sends=0;
 const config={apiUrl:'https://api.cocktaildesign.ru/api/',workerToken:'isolated-token',botToken:'isolated-bot-token',chatId:'123456'};
 const dependencies={receipts:{get:async id=>receipts.get(id)||null,put:async(id,v)=>receipts.set(id,v),remove:async id=>receipts.delete(id)},pause:async()=>{},isStopping:()=>state.stopping,
 verifyRecipient:async()=>{if(!state.verified)throw Error('recipient_mismatch')},
 fetchImpl:async(url,options)=>{const p=new URL(url).pathname,b=JSON.parse(options.body);calls.push({p,b});assert.equal(options.redirect,'error');assert(options.signal);
  if(p.endsWith('/order-claim'))return new Response(JSON.stringify({ok:true,item}));
  if(p.endsWith('/order-complete')){if(state.ackFails)throw Error('ack lost');return new Response('{"ok":true}');}
  if(p.endsWith('/sendMessage')){sends++;if(state.part2Fails&&sends===2)return new Response('{"ok":false,"parameters":{"retry_after":50}}',{status:429});return new Response(JSON.stringify({ok:true,result:{message_id:sends}}));}
  throw Error('Unexpected target');}};
 return {item,receipts,calls,state,config,dependencies};
}
test('order parts go only to fixed recipient as HTML and complete together',async()=>{
 const {createOrderWorker}=await load(),f=fixture();assert.equal(await createOrderWorker(f.config,f.dependencies).runOnce(),'delivered');
 const sends=f.calls.filter(c=>c.p.endsWith('/sendMessage'));assert.equal(sends.length,2);assert(sends.every(c=>c.b.chat_id==='123456'&&c.b.parse_mode==='HTML'));
 assert.deepEqual(f.calls.at(-1).b.messageIds,['1','2']);assert.equal(f.receipts.size,0);
});
test('lost completion resumes from durable part receipts without sending either part twice',async()=>{
 const {createOrderWorker}=await load(),f=fixture();f.state.ackFails=true;await assert.rejects(createOrderWorker(f.config,f.dependencies).runOnce());assert.equal(f.receipts.size,2);
 f.state.ackFails=false;f.item.leaseToken=randomUUID();assert.equal(await createOrderWorker(f.config,f.dependencies).runOnce(),'delivered');assert.equal(f.calls.filter(c=>c.p.endsWith('/sendMessage')).length,2);
});
test('partial Telegram failure retries only unsent parts',async()=>{
 const {createOrderWorker}=await load(),f=fixture();f.state.part2Fails=true;assert.equal(await createOrderWorker(f.config,f.dependencies).runOnce(),'retry_scheduled');assert.equal(f.receipts.size,1);assert.equal(f.calls.at(-1).b.retryAfter,50);
 f.state.part2Fails=false;f.item.leaseToken=randomUUID();assert.equal(await createOrderWorker(f.config,f.dependencies).runOnce(),'delivered');assert.equal(f.calls.filter(c=>c.p.endsWith('/sendMessage')&&c.b.text===f.item.messages[0]).length,1);
});
test('recipient mismatch, shutdown and expired lease prevent sends',async()=>{
 const {createOrderWorker}=await load();for(const mode of ['recipient','shutdown','expiry']){const f=fixture();if(mode==='recipient')f.state.verified=false;if(mode==='shutdown')f.state.stopping=true;if(mode==='expiry')f.item.leaseExpiresAt=new Date(0).toISOString();
 await assert.rejects(createOrderWorker(f.config,f.dependencies).runOnce());assert.equal(f.calls.filter(c=>c.p.endsWith('/sendMessage')).length,0);}
});
test('receipt keys are deterministic, separate per part and valid for durable storage',async()=>{
 const {partReceiptId,validOrderItem}=await load();const f=fixture();const a=partReceiptId(f.item.requestId,0);assert.equal(a,partReceiptId(f.item.requestId,0));assert.notEqual(a,partReceiptId(f.item.requestId,1));assert.match(a,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-a[\da-f]{3}-[\da-f]{12}$/);
 assert(validOrderItem(f.item));assert(!validOrderItem({...f.item,messages:['x'.repeat(4000)]}));
});
