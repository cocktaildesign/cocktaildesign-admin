const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const root=path.resolve(__dirname,'..');
const plain=x=>JSON.parse(JSON.stringify(x));
const variant=id=>({id,name:id,code:id,product:{meta:{href:'https://example.invalid/product/P'}},salePrices:[]});
const page=(id,next=false)=>({rows:[variant(id)],meta:next?{nextHref:'next'}:{}});

// Load the real sync, queue and lock/state code; DB, timers and ALL HTTP are fake.
function fixture(steps,{holdSleep=false}={}) {
 const stores=new Map(),cache=new Map();
 const s={requests:[],waits:[],writes:[],logs:[],timers:new Set(),resume:null,cancelled:0};
 const strapi={log:Object.fromEntries(['info','warn','error'].map(k=>[k,msg=>s.logs.push(msg)])),
  store:({key})=>({get:async()=>plain(stores.get(key)??null),set:async({value})=>stores.set(key,plain(value))}),
  db:{query(uid){
   if(uid.includes('moysklad-product'))return {findOne:async()=>({id:1})};
   assert(uid.includes('moysklad-variant'));
   return {findOne:async()=>null,create:async args=>s.writes.push(['create',plain(args)]),
    update:async args=>s.writes.push(['update',plain(args)]),deleteMany:async args=>s.writes.push(['delete',plain(args)])};
  }},
 };
 const setTimer=(fn,ms)=>{
  const t={fn,ms};s.timers.add(t);
  if(!String(fn).includes('.abort(')) {
   s.waits.push(ms);
   const fire=()=>{s.timers.delete(t);fn();};
   if(holdSleep)s.resume=fire;else queueMicrotask(fire);
  }
  return t;
 };
 const fetch=async(url,options)=>{
  assert.equal(options.method,undefined,'only implicit GET is allowed');
  assert.match(url,/^https:\/\/api\.moysklad\.ru\/api\/remap\/1\.2\/entity\/variant\?limit=100&offset=\d+$/);
  assert.equal(options.headers.Authorization,'Bearer isolated-dummy-token');
  assert.equal(s.timers.size,1,'only the current request timeout is active');
  s.requests.push(url);
  const step=steps.shift();assert(step,'Unexpected HTTP request');
  if(step.network)throw {cause:{code:step.network}};
  if(step.abort){const timer=[...s.timers][0];timer.fn();assert(options.signal.aborted);throw new DOMException('timeout','AbortError');}
  const response=new Response(step.raw??JSON.stringify(step.data??{errors:[{code:1049}]}),{status:step.status??200,headers:step.headers});
  const cancel=response.body.cancel.bind(response.body);
  response.body.cancel=async()=>{s.cancelled++;return cancel();};
  return response;
 };
 function load(file) {
  const full=path.resolve(root,file.endsWith('.ts')?file:file+'.ts');if(cache.has(full))return cache.get(full);
  const module={exports:{}};cache.set(full,module.exports);
  const source=ts.transpileModule(fs.readFileSync(full,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(source,{module,exports:module.exports,strapi,fetch,process:{env:{MOYSKLAD_ACCESS_TOKEN:'isolated-dummy-token'}},
   Response,AbortController,Date,console,setTimeout:setTimer,clearTimeout:t=>s.timers.delete(t),
   require(id){
    if(id==='crypto')return require('node:crypto');
    if(id.endsWith('rebuild-product-search-index'))return {rebuildAllProductSearchIndexes:async()=>{s.writes.push(['rebuild']);return {scanned:1,changed:1,unchanged:0};}};
    assert(id.startsWith('.'),'Unexpected dependency '+id);
    return load(path.relative(root,path.resolve(path.dirname(full),id)));
   }},{filename:full});
  cache.set(full,module.exports);return module.exports;
 }
 const sync=load('src/api/moysklad-variant/services/sync').syncAllVariants;
 const queue=load('src/utils/moysklad-mutation-queue');
 return {s,sync,queue,state:()=>stores.get('syncState'),steps};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));

test('429 retries the same page, releases response, then writes once after all pages',async()=>{
 const f=fixture([{status:429,headers:{'X-Lognex-Retry-After':'4500'}},{data:page('A',true)},{data:page('B')}]);
 const result=await f.sync();assert.equal(result.upserted,2);
 assert.deepEqual(f.s.waits,[4750]);assert.equal(f.s.cancelled,1);
 assert.equal(f.s.requests[0],f.s.requests[1]);assert.match(f.s.requests[2],/offset=100$/);
 assert.deepEqual(f.s.writes.map(x=>x[0]),['create','create','delete','rebuild']);
 assert.deepEqual(f.s.writes[2][1].where.moyskladId.$notIn,['A','B']);
 assert.equal(f.state().status,'ok');assert.equal(f.state().lock.isLocked,false);assert.equal(f.s.timers.size,0);
 assert(!f.s.logs.join('\n').includes('isolated-dummy-token'));
});

for(const [label,headers,wait] of [
 ['fallback',{},3250],['reset milliseconds',{'X-Lognex-Reset':'7000'},7250],
 ['larger header',{'X-Lognex-Retry-After':'6000','X-Lognex-Reset':'8000'},8250],
 ['invalid headers',{'X-Lognex-Retry-After':'bad','X-Lognex-Reset':'-10'},3250],
 ['zero header',{'X-Lognex-Retry-After':'0'},3250],
])test(label,async()=>{const f=fixture([{status:429,headers},{data:page('A')}]);await f.sync();assert.deepEqual(f.s.waits,[wait]);});

test('persistent 429 has four attempts, no DB mutation; lock and queue recover',async()=>{
 const f=fixture(Array.from({length:4},()=>({status:429})));
 await assert.rejects(f.sync(),/MoySklad API error 429/);
 assert.deepEqual(f.s.waits,[3250,6250,12250]);assert.equal(f.s.cancelled,3);assert.equal(f.s.requests.length,4);
 assert.deepEqual(f.s.writes,[]);assert.equal(f.state().status,'error');assert.equal(f.state().lock.isLocked,false);
 f.steps.push({data:page('A')});await f.sync();assert.equal(f.state().status,'ok');
});

test('a failed later page never applies a partial snapshot or deletes old variants',async()=>{
 const f=fixture([{data:page('A',true)},...Array.from({length:4},()=>({status:429}))]);
 await assert.rejects(f.sync(),/429/);assert.deepEqual(f.s.writes,[]);assert.equal(f.state().lock.isLocked,false);
});

test('60 second wait budget is shared across pages and reset on a new run',async()=>{
 const limit=()=>({status:429,headers:{'X-Lognex-Retry-After':'20000'}});
 const f=fixture([limit(),{data:page('A',true)},limit(),{data:page('B',true)},limit()]);
 await assert.rejects(f.sync(),/429/);assert.deepEqual(f.s.waits,[20250,20250]);assert.deepEqual(f.s.writes,[]);
 f.steps.push(limit(),{data:page('A')});await f.sync();assert.equal(f.s.waits.at(-1),20250);
});

test('long API cooldown fails safely instead of retrying too early',async()=>{
 const f=fixture([{status:429,headers:{'X-Lognex-Retry-After':'120000'}}]);
 await assert.rejects(f.sync(),/429/);assert.deepEqual(f.s.waits,[]);assert.deepEqual(f.s.writes,[]);
});

for(const status of [401,403,404,500,503])test('HTTP '+status+' keeps prior no-retry behavior',async()=>{
 const f=fixture([{status}]);await assert.rejects(f.sync(),new RegExp('error '+status));
 assert.equal(f.s.requests.length,1);assert.deepEqual(f.s.waits,[]);assert.deepEqual(f.s.writes,[]);
 assert.equal(f.state().lock.isLocked,false);
});

test('successful requests and payloads are unchanged',async()=>{
 const f=fixture([{data:page('A')}]);await f.sync();assert.deepEqual(f.s.waits,[]);assert.equal(f.s.requests.length,1);
 const data=f.s.writes[0][1].data;assert.equal(data.code,'A');assert.equal(data.product,1);assert.equal(data.name,'A');
});

test('network retries retain previous backoff and share the four-attempt cap with 429',async()=>{
 const f=fixture([{network:'UND_ERR_CONNECT_TIMEOUT'},{status:429},{network:'UND_ERR_SOCKET'},{data:page('A')}]);
 await f.sync();assert.deepEqual(f.s.waits,[500,6250,1500]);assert.equal(f.s.requests.length,4);
});

test('request timeout and bad JSON release the lock without writes',async()=>{
 for(const step of [{abort:true},{raw:'not-json'},{data:{unexpected:true}}]){
  const f=fixture([step]);await assert.rejects(f.sync());assert.equal(f.s.requests.length,1);
  assert.deepEqual(f.s.writes,[]);assert.equal(f.state().lock.isLocked,false);assert.equal(f.s.timers.size,0);
 }
});

test('existing serialization holds during wait and releases for the next mutation',async()=>{
 const f=fixture([{status:429},{data:page('A')}],{holdSleep:true});
 const first=f.sync();await settled();assert.equal(f.state().lock.isLocked,true);assert(f.s.resume);
 await assert.rejects(f.sync(),/Sync lock is already acquired/);
 let nextRan=false;const second=f.queue.enqueueMoySkladMutation('webhook',async()=>{nextRan=true;});
 await settled();assert.equal(nextRan,false);assert.deepEqual(f.s.writes,[]);
 f.s.resume();await first;await second;assert.equal(nextRan,true);assert.equal(f.state().lock.isLocked,false);
});
