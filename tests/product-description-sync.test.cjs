const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),sample='b4121850-6ab7-11ef-0a80-01fa00116171';
const text='  Первый  абзац.\r\n\r\nВторой   абзац.\nСтрока <b>текст</b>  ';
const entity=(id,folder=sample,description=text)=>({id,name:'CRM '+id,code:id,description,meta:{href:'https://example.test/product/'+id},productFolder:{meta:{href:'https://example.test/folder/'+folder}},salePrices:[]});
const plain=x=>JSON.parse(JSON.stringify(x));
function harness({stock=3,stockError=false,missingStock=false,existing=true}={}){
 const writes=[],cache=new Map(),rows=existing?[{id:1,moyskladId:'A',type:'product',category:{moyskladId:sample},description:'Old',displayTitle:'Editorial title',slug:'stable',image:[42],discountExcluded:true,engraving:true}]:[];
 const categories=[{id:10,moyskladId:sample},{id:11,moyskladId:'ordinary'}];
 let source=[entity('A')],bundles=[];
 const pq={findOne:async()=>rows[0]??null,findMany:async()=>rows,
  update:async({where,data})=>{writes.push(plain({op:'update',where,data}));Object.assign(rows.find(r=>r.id===where.id),data);return rows.find(r=>r.id===where.id);},
  create:async({data})=>{writes.push(plain({op:'create',data}));const r={id:1,...data};rows.push(r);return r;},deleteMany:async()=>({count:0})};
 const app={log:{info(){},warn(){},error(){}},contentTypes:{'api::moysklad-product.moysklad-product':{attributes:{slug:{}}}},
  documents:()=>({findFirst:async()=>null}),db:{query:uid=>{
   if(uid.includes('moysklad-product'))return pq;
   if(uid.includes('moysklad-category'))return {findOne:async({where})=>categories.find(c=>c.moyskladId===where.moyskladId),findMany:async()=>categories,update:async()=>{}};
   if(uid.includes('moysklad-variant'))return {deleteMany:async()=>({count:0})};
   throw Error('Unexpected DB '+uid);
  }}};
 const item={moyskladId:'A',stock,productFolderId:sample,type:'product'};
 function load(file){file=path.resolve(root,file.endsWith('.ts')?file:file+'.ts');if(cache.has(file))return cache.get(file);
  const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,strapi:app,process:{env:{MOYSKLAD_ACCESS_TOKEN:'fake'}},console,
   fetch:async url=>({ok:true,json:async()=>({rows:url.includes('/bundle?')?bundles:source,meta:{}})}),
   require:id=>{
    if(id==='@strapi/strapi')return {factories:{createCoreService:(_,factory)=>factory({strapi:app})}};
    if(id.endsWith('moysklad-sync-state'))return Object.fromEntries(['acquireMoySkladSyncLock','releaseMoySkladSyncLock','markSyncError','markSyncOk','markSyncRunning'].map(k=>[k,async()=>{}]));
    if(id.endsWith('moysklad-mutation-queue'))return {enqueueMoySkladFullSync:(_,fn)=>fn()};
    if(id.endsWith('rebuild-product-search-index'))return {rebuildProductSearchIndex:async()=>{}};
    if(id.includes('moysklad-bundle-item/services/sync'))return {syncBundleItemsForBundle:async()=>({created:0,skipped:0})};
    const loaded=load(path.resolve(path.dirname(file),id));
    if(id.endsWith('moysklad-sample-sale'))return {...loaded,fetchSampleSaleAssortment:async()=>{if(stockError)throw Error('CRM unavailable');return missingStock?[]:[item]},fetchSampleSaleAssortmentItemById:async()=>{if(stockError)throw Error('CRM unavailable');return missingStock?null:item}};
    return loaded;
   }},{filename:file});cache.set(file,module.exports);return module.exports;
 }
 return {service:load('src/api/moysklad-product/services/moysklad-product').default,rows,writes,setSource:(p,b=[])=>{source=p;bundles=b;}};
}
for(const mode of ['webhook','full'])for(const stock of [3,0,-1])test(`${mode}: Sample Sale stock ${stock}, exact description, editorial fields preserved`,async()=>{
 const h=harness({stock}),before=plain(h.rows[0]);
 if(mode==='webhook')await h.service.syncOneFromWebhook(entity('A'));else await h.service.syncAllUnlocked();
 assert.equal(h.rows[0].description,text);assert.equal(h.rows[0].isOutOfStock,stock<=0);
 for(const key of ['displayTitle','slug','image','discountExcluded','engraving'])assert.deepEqual(h.rows[0][key],before[key]);
 if(stock<=0)assert.deepEqual(Object.keys(h.writes[0].data).sort(),['description','isOutOfStock','moyskladStock']);
});
for(const mode of ['webhook','full'])for(const description of ['',undefined])test(`${mode}: cleared CRM description (${String(description)}) clears stale text`,async()=>{
 const h=harness();const e=entity('A');if(description===undefined)delete e.description;else e.description=description;
 h.setSource([e]);if(mode==='webhook')await h.service.syncOneFromWebhook(e);else await h.service.syncAllUnlocked();
 assert.equal(h.rows[0].description,description??null);
});
for(const mode of ['webhook','full'])test(`${mode}: stock request failure never clears or changes saved description`,async()=>{
 const h=harness({stockError:true}),before=plain(h.rows);if(mode==='webhook')await h.service.syncOneFromWebhook(entity('A'));else await assert.rejects(h.service.syncAllUnlocked(),/CRM unavailable/);
 assert.deepEqual(h.rows,before);assert.equal(h.writes.length,0);
});
test('missing stock row also preserves descriptions',async()=>{const h=harness({missingStock:true});await h.service.syncOneFromWebhook(entity('A'));assert.equal(h.writes.length,0);await assert.rejects(h.service.syncAllUnlocked());assert.equal(h.writes.length,0)});
test('new Sample Sale retains exact text; unavailable new products remain skipped',async()=>{
 for(const stock of [1,0]){const h=harness({existing:false,stock});await h.service.syncOneFromWebhook(entity('A'));assert.equal(h.writes.length,stock?1:0);if(stock)assert.equal(h.rows[0].description,text);}
});
test('ordinary product and bundle still take exact CRM description',async()=>{
 for(const bundle of [false,true]){const h=harness();const e=entity('A','ordinary');if(bundle)await h.service.syncOneBundleFromWebhook(e);else await h.service.syncOneFromWebhook(e);assert.equal(h.rows[0].description,text);}
 const h=harness();h.setSource([entity('A','ordinary')],[entity('B','ordinary')]);await h.service.syncAllUnlocked();assert(h.writes.every(w=>w.data.description===text));
});
