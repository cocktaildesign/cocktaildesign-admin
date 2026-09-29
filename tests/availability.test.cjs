const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const row=(n,quantity=0,type='product')=>({id:id(n),quantity,meta:{type}});
const page=(rows,size=rows.length,offset=0)=>({meta:{size,offset},rows});
function harness(){
 const env={MOYSKLAD_AVAILABILITY_ENABLED:'true',MOYSKLAD_ACCESS_TOKEN:'test-only'};
 const cache=new Map(),calls=[];let response=page([row(1)]),failWrite=false;
 const values=new Map(),products=[{moyskladId:id(1),variants:[]}],logs=[];
 const fetcher=async(url,options)=>{calls.push({url,options});if(response instanceof Error)throw response;return {ok:true,json:async()=>response}};
 function load(file){file=path.resolve(__dirname,'..',file.endsWith('.ts')?file:file+'.ts');if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:n=>load(path.resolve(path.dirname(file),n)),process:{env},fetch:fetcher,URLSearchParams,AbortSignal,setTimeout,clearTimeout,console},{filename:file});return module.exports;
 }
 const app={store:cfg=>({get:async()=>values.get(cfg.key),set:async({value})=>{assert.equal(cfg.key,'availability-v1');if(failWrite)throw Error('disk');values.set(cfg.key,value)}}),
  db:{query:uid=>{assert.equal(uid,'api::moysklad-product.moysklad-product');return {findMany:async opts=>{assert.ok(opts.where.$and);return products}}}},
  log:{info:x=>logs.push(x),warn:x=>logs.push(x)}};
 return {env,load,app,values,products,calls,logs,setResponse:r=>response=r,setFailWrite:()=>failWrite=true};
}
test('all warehouses: exact quantity, not physical stock; zero and negative are unavailable',async()=>{
 const {load}=harness();const requests=[];
 const rows=[{...row(1,0),stock:10,reserve:10},{...row(2,-3),stock:20,reserve:23},{...row(3,4),stock:0,reserve:0,inTransit:4},row(4,undefined,'bundle'),row(5,undefined,'service')];
 const states=await load('src/utils/moysklad-availability').readMoySkladAvailability('fake',async(url,options)=>{requests.push(url);assert.equal(options.method,'GET');return {ok:true,json:async()=>page(rows)}});
 assert.deepEqual(Array.from(states,([key,value])=>[key,value]),[[id(1),true],[id(2),true],[id(3),false]]);
 const url=new URL(requests[0]);assert.equal(url.searchParams.get('filter'),'stockMode=all;quantityMode=all');assert.equal(url.searchParams.get('groupBy'),'variant');assert.ok(!url.toString().includes('stockStore'));
});
test('full paging; no partial snapshots or duplicate IDs',async()=>{
 const {load}=harness();const read=load('src/utils/moysklad-availability').readMoySkladAvailability;
 const first=Array.from({length:1000},(_,i)=>row(i+1,1));let count=0;
 const result=await read('fake',async url=>{const offset=Number(new URL(url).searchParams.get('offset'));count++;return {ok:true,json:async()=>page(offset?[row(1001,-1)]:first,1001,offset)}});
 assert.equal(result.size,1001);assert.equal(count,2);assert.equal(result.get(id(1001)),true);
 for(const bad of [page([],0),page([row(1)],2),page([row(1),row(1)]),page([row(1,null)]),page([row(1,'0')]),page([row(1,NaN)]),page([row(1,0,'unexpected')])]){
  await assert.rejects(read('fake',async()=>({ok:true,json:async()=>bad})));
 }
 await assert.rejects(read('fake',async()=>({ok:false,status:429})),/429/);
});
test('visible products only; variants individual and parent available when any variant is positive',async()=>{
 const h=harness();h.products.push({moyskladId:id(2),variants:[{moyskladId:id(3)},{moyskladId:id(4)}]});
 h.setResponse(page([row(1,0),row(2,-3),row(3,2,'variant'),row(4,-5,'variant'),row(99,0)]));
 await h.load('src/utils/availability-job').refreshAvailability(h.app);
 const saved=h.values.get('availability-v1');assert.deepEqual({...saved.states},{[id(1)]:true,[id(2)]:false,[id(3)]:false,[id(4)]:true});
 assert.equal(saved.states[id(99)],undefined);assert.ok(!JSON.stringify(saved).includes('quantity'));
});
test('all variants empty marks parent; missing variant is unknown, not zero',async()=>{
 const h=harness();h.products.splice(0,1,{moyskladId:id(1),variants:[{moyskladId:id(2)},{moyskladId:id(3)}]});
 h.setResponse(page([row(1,0),row(2,0,'variant'),row(3,-1,'variant')]));const job=h.load('src/utils/availability-job');
 await job.refreshAvailability(h.app);assert.equal(h.values.get('availability-v1').states[id(1)],true);
 h.setResponse(page([row(1,0),row(2,0,'variant')]));await job.refreshAvailability(h.app);
 assert.equal(h.values.get('availability-v1').states[id(1)],undefined);
});
test('replenishment clears badge; failed CRM/DB refresh preserves saved state, restart loads it',async()=>{
 const h=harness(),job=h.load('src/utils/availability-job');
 await job.refreshAvailability(h.app);assert.equal((await job.getAvailabilitySnapshot(h.app)).states[id(1)],true);
 h.setResponse(page([row(1,5)]));await job.refreshAvailability(h.app);assert.equal((await job.getAvailabilitySnapshot(h.app)).states[id(1)],false);
 const saved=JSON.stringify(h.values.get('availability-v1'));
 h.setResponse(Error('secret in provider error'));await job.refreshAvailability(h.app);assert.equal(JSON.stringify(h.values.get('availability-v1')),saved);
 h.setResponse(page([row(1,0)]));h.setFailWrite();await job.refreshAvailability(h.app);
 assert.equal((await job.getAvailabilitySnapshot(h.app)).states[id(1)],false);assert.ok(!h.logs.join().includes('secret'));
 const restart=harness();restart.values.set('availability-v1',JSON.parse(saved));
 assert.equal((await restart.load('src/utils/availability-job').getAvailabilitySnapshot(restart.app)).states[id(1)],false);
});
test('disabled feature and existing catalog sync perform no CRM calls/writes',async()=>{
 const h=harness(),job=h.load('src/utils/availability-job');h.env.MOYSKLAD_AVAILABILITY_ENABLED='false';
 await job.refreshAvailability(h.app);assert.equal(h.calls.length,0);assert.equal(Object.keys((await job.getAvailabilitySnapshot(h.app)).states).length,0);
 h.env.MOYSKLAD_AVAILABILITY_ENABLED='true';h.values.set('syncState',{lock:{isLocked:true}});
 await job.refreshAvailability(h.app);assert.equal(h.calls.length,0);assert.equal(h.values.has('availability-v1'),false);
});
