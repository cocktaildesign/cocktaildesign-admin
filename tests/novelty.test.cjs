const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const uuid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const date='2026-08-20T07:23:47.011Z';
function matches(row,where){return Object.entries(where).every(([key,value])=>{
 if(key==='$or')return value.some(v=>matches(row,v));
 if(value&&typeof value==='object')return Object.entries(value).every(([op,v])=>op==='$null'?row[key]==null:op==='$gt'?row[key]>v:op==='$lt'?row[key]<v:false);
 return row[key]===value;
});}
function harness(){
 const env={MOYSKLAD_NOVELTY_ENABLED:'true',MOYSKLAD_ACCESS_TOKEN:'fake'},cache=new Map(),requests=[],writes=[],logs=[],store=new Map();
 const products=[],variants=[];let failWrite=false,fetcher=async()=>({ok:true,json:async()=>({meta:{size:1},rows:[{eventType:'create',entityType:'product',moment:'2026-08-20 10:23:47.011'}]})});
 function load(file){file=path.resolve(__dirname,'..',file.endsWith('.ts')?file:file+'.ts');if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:n=>load(path.resolve(path.dirname(file),n)),process:{env},Date,fetch:async(...a)=>{requests.push(a);return fetcher(...a)},AbortController,URLSearchParams,
   setTimeout:(fn,ms)=>setTimeout(fn,ms===300?0:ms),clearTimeout,console},{filename:file});return module.exports;}
 const app={store:cfg=>({get:async()=>store.get(cfg.key),set:async({value})=>{assert.equal(cfg.key,'novelty-sync-v1');store.set(cfg.key,value)}}),
  log:{info:m=>logs.push(m),warn:m=>logs.push(m)},db:{query:uid=>{
   assert.ok(['api::moysklad-product.moysklad-product','api::moysklad-variant.moysklad-variant'].includes(uid));const rows=uid.includes('moysklad-variant.')?variants:products;
   return {findMany:async opts=>rows.filter(r=>matches(r,opts.where)).sort((a,b)=>a.id-b.id).slice(0,opts.limit).map(r=>({...r})),
    updateMany:async opts=>{if(failWrite)throw Error('db secret');assert.equal(Object.keys(opts.data).length,1);assert.ok(Object.keys(opts.data).every(k=>['moyskladCreatedAt','moyskladNoveltyAt'].includes(k)));writes.push(opts);let count=0;for(const row of rows)if(matches(row,opts.where)){Object.assign(row,opts.data);count++}return {count}}};}}};
 const job=load('src/utils/novelty-job');
 return {env,load,app,products,variants,requests,writes,logs,store,job,setFetch:f=>fetcher=f,failWrite:()=>failWrite=true,
  add:(id,extra={})=>{const p={id,moyskladId:uuid(id),type:'product',price:1234,priceOld:1500,discountExcluded:true,isHiddenOnSite:false,moyskladCreatedAt:null,moyskladNoveltyAt:null,variants:[],...extra};products.push(p);return p}};
}
test('CRM creation time is Moscow; never uses updated/import date; metadata only and idempotent',async()=>{
 const h=harness(),p=h.add(1,{updated:'2026-10-01',createdAt:'2026-09-01'}),before={...p};
 await h.job.refreshNovelty(h.app);assert.equal(p.moyskladCreatedAt,date);assert.equal(p.moyskladNoveltyAt,date);
 assert.deepEqual({...p,moyskladCreatedAt:null,moyskladNoveltyAt:null},before);assert.equal(h.requests.length,1);
 assert.ok(h.requests[0][0].endsWith('/product/'+uuid(1)+'/audit?limit=100&offset=0'));
 await h.job.refreshNovelty(h.app);assert.equal(h.requests.length,1);assert.equal(h.writes.length,2);
});
test('existing variant rule and bundles; never moves a saved novelty date backwards',async()=>{
 const h=harness();const calc=h.job.calculateNoveltyDate;
 assert.equal(calc({type:'product',moyskladCreatedAt:'2026-08-01',variants:[{moyskladCreatedAt:date}]}),date);
 assert.equal(calc({type:'bundle',moyskladCreatedAt:'2026-08-01',variants:[{moyskladCreatedAt:date}]}),'2026-08-01T00:00:00.000Z');
 assert.equal(calc({variants:[{moyskladCreatedAt:'invalid'}]}),null);
 const p=h.add(1,{moyskladCreatedAt:date,moyskladNoveltyAt:'2026-09-01T00:00:00.000Z'});
 await h.job.refreshNovelty(h.app);assert.equal(p.moyskladNoveltyAt,'2026-09-01T00:00:00.000Z');assert.equal(h.writes.length,0);
});
test('bounded batches and persistent cursor reach later products, then wrap around failures',async()=>{
 const h=harness();for(let i=1;i<=14;i++)h.add(i);
 h.setFetch(async url=>({ok:true,json:async()=>({rows:url.includes(uuid(1)+'/')?[]:[{entityType:'product',eventType:'create',moment:date}]})}));
 await h.job.refreshNovelty(h.app);assert.equal(h.requests.length,6);assert.equal(h.products[0].moyskladCreatedAt,null);
 await h.job.refreshNovelty(h.app);assert.equal(h.requests.length,12);assert.equal(h.products[11].moyskladCreatedAt,date);
 await h.job.refreshNovelty(h.app);assert.equal(h.products[13].moyskladCreatedAt,date);
 await h.job.refreshNovelty(h.app);assert.equal(h.requests.length,15);
});
test('429, missing history, future date and DB failure preserve data and do not throw into main sync',async()=>{
 for(const mode of ['429','missing','future','database']){
  const h=harness(),p=h.add(1);if(mode==='429')h.setFetch(async()=>({ok:false,status:429}));
  if(mode==='missing')h.setFetch(async()=>({ok:true,json:async()=>({rows:[]})}));
  if(mode==='future')h.setFetch(async()=>({ok:true,json:async()=>({rows:[{eventType:'create',entityType:'product',moment:'2099-01-01'}]})}));
  if(mode==='database')h.failWrite();await h.job.refreshNovelty(h.app);assert.equal(p.moyskladCreatedAt,null);assert.equal(p.moyskladNoveltyAt,null);
  assert.equal(h.requests.length,1);assert.ok(!h.logs.join('').includes('secret'));
 }
});
test('disabled, full sync lock and overlapping runs do not add CRM load',async()=>{
 const h=harness();h.add(1);h.env.MOYSKLAD_NOVELTY_ENABLED='false';await h.job.refreshNovelty(h.app);assert.equal(h.requests.length,0);
 h.env.MOYSKLAD_NOVELTY_ENABLED='true';h.store.set('syncState',{lock:{isLocked:true}});await h.job.refreshNovelty(h.app);assert.equal(h.requests.length,0);
 h.store.delete('syncState');let release;h.setFetch(()=>new Promise(r=>release=r));const first=h.job.refreshNovelty(h.app);
 while(!release)await new Promise(r=>setImmediate(r));await h.job.refreshNovelty(h.app);assert.equal(h.requests.length,1);
 release({ok:true,json:async()=>({rows:[]})});await first;
});
test('a date filled concurrently is not overwritten; reconciliation repairs an interrupted run',async()=>{
 const h=harness(),p=h.add(1);h.setFetch(async()=>{p.moyskladCreatedAt='2026-09-17T00:00:00.000Z';return {ok:true,json:async()=>({rows:[{eventType:'create',entityType:'product',moment:date}]})}});
 await h.job.refreshNovelty(h.app);assert.equal(p.moyskladCreatedAt,'2026-09-17T00:00:00.000Z');assert.equal(p.moyskladNoveltyAt,p.moyskladCreatedAt);
});
test('variants use variant audit and update the parent novelty; bundle uses bundle audit',async()=>{
 const h=harness(),v={id:1,moyskladId:uuid(51),moyskladCreatedAt:null};h.variants.push(v);const p=h.add(1,{moyskladCreatedAt:'2026-07-01T00:00:00.000Z',variants:[v]});const b=h.add(2,{type:'bundle'});
 h.setFetch(async url=>({ok:true,json:async()=>({rows:[{eventType:'create',entityType:url.includes('/variant/')?'variant':'bundle',moment:date}]})}));
 await h.job.refreshNovelty(h.app);assert.equal(v.moyskladCreatedAt,date);assert.equal(p.moyskladNoveltyAt,date);assert.equal(b.moyskladNoveltyAt,date);assert.equal(h.requests.length,2);
});
test('audit pagination, page/deadline bounds and not-found; read-only methods',async()=>{
 const h=harness(),read=h.load('src/utils/moysklad-audit').fetchMoySkladEntityCreatedAt;
 h.setFetch(async(url,opts)=>{assert.equal(opts.method,undefined);const next=url.endsWith('offset=100');return {ok:true,json:async()=>({meta:{size:101},rows:next?[{eventType:'create',entityType:'product',moment:date}]:Array.from({length:100},()=>({eventType:'update'}))})}});
 assert.equal(await read('product',uuid(1),{maxPages:2,maxAttempts:1}),date);
 await assert.rejects(read('product',uuid(1),{maxPages:1,maxAttempts:1}),/page limit/);
 await assert.rejects(read('product',uuid(1),{deadlineMs:Date.now()-1,maxAttempts:1}),/deadline/);
 h.setFetch(async()=>({ok:false,status:404}));assert.equal(await read('product',uuid(1),{maxAttempts:1}),null);
});
test('60-day boundary uses creation date inclusive; null never becomes a new item',()=>{
 const h=harness(),isNew=h.load('src/utils/product-novelty').isProductNew;
 assert.equal(isNew(new Date(Date.now()-59*86400000).toISOString(),60),true);
 assert.equal(isNew(new Date(Date.now()-61*86400000).toISOString(),60),false);
 assert.equal(isNew(null,60),false);
});
