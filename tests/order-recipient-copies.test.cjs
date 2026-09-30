const test = require('node:test'), assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const load = name => import(pathToFileURL(path.resolve(__dirname, '../ops/feedback-worker', name + '.mjs')).href);
const extra = [{chatId:'234567',username:'office_one'},{chatId:'345678',username:'office_two'}];
const env = {FEEDBACK_WORKER_TOKEN:'isolated-worker-00000000000000000000',TELEGRAM_BOT_TOKEN:'123456789:isolated-test-token-00000000000000000',TELEGRAM_CHAT_ID:'123456',TELEGRAM_EXPECTED_USERNAME:'DK_cocktaildesign'};
async function fixture() {
  const {configuration} = await load('worker');
  const config = configuration({...env,ORDER_TELEGRAM_EXTRA_RECIPIENTS:JSON.stringify(extra)});
  const item = {id:1,requestId:randomUUID(),leaseToken:randomUUID(),leaseExpiresAt:new Date(Date.now()+1800000).toISOString(),messages:['First part','Last part']};
  const saved = new Map(), calls = [], state = {blocked:null,wrongIdentity:null,ackFails:false,stop:false};
  let nextMessageId=100;
  const deps = {verifyRecipient:async()=>{},pause:async()=>{},isStopping:()=>state.stop,
    receipts:{get:async id=>saved.get(id)||null,put:async(id,value)=>saved.set(id,value),remove:async id=>saved.delete(id)},
    fetchImpl:async(url,options)=>{
      const method=new URL(url).pathname.split('/').at(-1), body=JSON.parse(options.body); calls.push({method,body});
      assert.equal(options.redirect,'error');assert(options.signal);
      const ok=result=>new Response(JSON.stringify({ok:true,...result}));
      if(method==='order-claim')return ok({item});
      if(method==='order-complete'){if(state.ackFails)throw Error('lost acknowledgement');return ok({});}
      if(method==='getChat'){
        const recipient=extra.find(r=>r.chatId===body.chat_id);assert(recipient);
        return ok({result:{id:Number(recipient.chatId),type:'private',username:state.wrongIdentity===recipient.chatId?'wrong_user':recipient.username.toUpperCase()}});
      }
      if(method==='sendMessage'){
        if(body.chat_id===state.blocked)return new Response(JSON.stringify({ok:false,parameters:{retry_after:70}}),{status:403});
        return ok({result:{message_id:++nextMessageId}});
      }
      throw Error('Unexpected endpoint');
    }};
  return {config,item,deps,saved,calls,state};
}
const sends=f=>f.calls.filter(c=>c.method==='sendMessage');

test('each order part reaches three private chats; backend keeps the existing primary-only acknowledgement',async()=>{
  const {createOrderWorker}=await load('orders'),f=await fixture();
  assert.equal(await createOrderWorker(f.config,f.deps).runOnce(),'delivered');
  assert.deepEqual(sends(f).map(c=>c.body.chat_id),['123456','123456','234567','234567','345678','345678']);
  assert(sends(f).every(c=>c.body.parse_mode==='HTML'));
  assert.deepEqual(f.calls.at(-1).body.messageIds,['101','102']);assert.equal(f.saved.size,0);
});
test('blocked middle recipient does not prevent owner or third recipient; restart retries only the missing copy',async()=>{
  const {createOrderWorker}=await load('orders'),f=await fixture();f.state.blocked='234567';
  assert.equal(await createOrderWorker(f.config,f.deps).runOnce(),'retry_scheduled');
  assert.equal(f.saved.size,4);assert.equal(f.calls.at(-1).body.ok,false);assert.equal(f.calls.at(-1).body.retryAfter,70);
  assert.equal(sends(f).filter(c=>c.body.chat_id==='345678').length,2);
  f.state.blocked=null;f.item.leaseToken=randomUUID();
  assert.equal(await createOrderWorker(f.config,f.deps).runOnce(),'delivered');
  for(const id of ['123456','345678'])assert.equal(sends(f).filter(c=>c.body.chat_id===id).length,2);
  assert.equal(f.saved.size,0);
});
test('lost final acknowledgement reuses receipts for all three recipients after restart',async()=>{
  const {createOrderWorker}=await load('orders'),f=await fixture();f.state.ackFails=true;
  await assert.rejects(createOrderWorker(f.config,f.deps).runOnce());assert.equal(f.saved.size,6);
  f.state.ackFails=false;f.state.wrongIdentity='234567';
  assert.equal(await createOrderWorker(f.config,f.deps).runOnce(),'delivered');assert.equal(sends(f).length,6);
});
test('wrong extra recipient identity never receives customer data and does not block verified chats',async()=>{
  const {createOrderWorker}=await load('orders'),f=await fixture();f.state.wrongIdentity='234567';
  assert.equal(await createOrderWorker(f.config,f.deps).runOnce(),'retry_scheduled');
  assert.equal(sends(f).filter(c=>c.body.chat_id==='234567').length,0);
  assert.equal(sends(f).length,4);assert.equal(f.calls.at(-1).body.error,'order_recipient_verification_failed');
});
test('deployment recipient check neither claims orders nor sends messages',async()=>{
  const {createOrderWorker}=await load('orders'),f=await fixture();await createOrderWorker(f.config,f.deps).verifyRecipients();
  assert.deepEqual(f.calls.map(c=>c.method),['getChat','getChat']);
});
test('existing owner receipt is honoured when extra recipients are introduced',async()=>{
  const {createOrderWorker,partReceiptId}=await load('orders'),f=await fixture();
  f.saved.set(partReceiptId(f.item.requestId,0),'42');
  assert.equal(await createOrderWorker(f.config,f.deps).runOnce(),'delivered');
  assert.equal(sends(f).filter(c=>c.body.chat_id==='123456').length,1);
  assert.equal(f.calls.at(-1).body.messageIds[0],'42');
  assert.notEqual(partReceiptId(f.item.requestId,0,'234567'),partReceiptId(f.item.requestId,0,'345678'));
});
test('100-part order stays within the unchanged website completion contract',async()=>{
  const {createOrderWorker}=await load('orders'),f=await fixture();f.item.messages=Array.from({length:100},(_,i)=>`Part ${i}`);
  assert.equal(await createOrderWorker(f.config,f.deps).runOnce(),'delivered');
  assert.equal(sends(f).length,300);assert.equal(f.calls.at(-1).body.messageIds.length,100);
});
test('shutdown during pacing does not send the next part',async()=>{
  const {createOrderWorker}=await load('orders'),f=await fixture();f.deps.pause=async()=>{f.state.stop=true};
  await assert.rejects(createOrderWorker(f.config,f.deps).runOnce(),/interrupted/);assert.equal(sends(f).length,0);
});
test('configuration rejects duplicate IDs, duplicate names, non-private IDs and malformed extra recipients',async()=>{
  const {configuration}=await load('worker');
  for(const bad of [null,{},[{chatId:'-10012345',username:'office'}],[{chatId:123456,username:'office'}],
    [{chatId:'123456',username:'office'}],[...extra,{chatId:'456789',username:'OFFICE_ONE'}],[...extra,extra[0]],
    [{chatId:'234567',username:'@office'}],Array(5).fill(extra[0])]){
    assert.throws(()=>configuration({...env,ORDER_TELEGRAM_EXTRA_RECIPIENTS:JSON.stringify(bad)}));
  }
  assert.throws(()=>configuration({...env,ORDER_TELEGRAM_EXTRA_RECIPIENTS:'broken json'}));
  assert.deepEqual(configuration(env).extraOrderRecipients,[]);
});
test('feedback with extra order recipients still sends only to the owner',async()=>{
  const {createWorker}=await load('worker'),f=await fixture();
  const message={id:1,requestId:randomUUID(),leaseToken:randomUUID(),message:'Feedback',email:null,page:'/support/feedback'};
  const calls=[];
  const worker=createWorker(f.config,{receipts:f.deps.receipts,fetchImpl:async(url,options)=>{
    const method=new URL(url).pathname.split('/').at(-1),body=JSON.parse(options.body);calls.push({method,body});
    const result=method==='getMe'?{username:'CD_ORDER_BOT'}:method==='getChat'?{id:123456,type:'private',username:'DK_cocktaildesign'}:{message_id:42};
    return new Response(JSON.stringify({ok:true,result,...(method==='claim'?{item:message}:{})}));
  }});
  assert.equal(await worker.runOnce(),'delivered');
  assert.deepEqual(calls.filter(c=>c.method==='sendMessage').map(c=>c.body.chat_id),['123456']);
});
