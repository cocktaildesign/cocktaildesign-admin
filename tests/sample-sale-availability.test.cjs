const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function harness({locked=false,folders=['sale','child'],products=[]}={}){
 const writes=[],queries=[],serial=[];
 const app={store:()=>({get:async()=>({lock:{isLocked:locked}})}),db:{query:()=>({
  findMany:async options=>{queries.push(options);return products},
  updateMany:async options=>{writes.push(options);return {count:options.where.id.$in.length}}
 })}};
 const file=path.resolve(__dirname,'../src/utils/sample-sale-availability.ts'),module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require:name=>{
  if(name.endsWith('product-discount-policy'))return {loadSampleSaleFolderIdSet:async()=>new Set(folders)};
  if(name.endsWith('moysklad-mutation-queue'))return {enqueueMoySkladMutation:async(kind,fn)=>{serial.push(kind);return fn()}};
  throw Error(name);
 }});
 return {...module.exports,app,writes,queries,serial};
}
test('only confirmed empty items, including all-empty variants; unknown and positive are preserved',async()=>{
 const h=harness({products:[
  {id:1,moyskladId:'empty'},{id:2,moyskladId:'positive'},{id:3,moyskladId:'missing'},
  {id:4,moyskladId:'parent',variants:[{moyskladId:'empty'},{moyskladId:'positive'}]},
  {id:5,variants:[{moyskladId:'empty'},{moyskladId:'missing'}]},
  {id:6,variants:[{moyskladId:'empty'}]},
 ]});
 const started='2026-10-20T11:00:00.000Z';
 assert.equal(await h.hideUnavailableSampleSale(h.app,new Map([['empty',true],['positive',false],['parent',true]]),started),2);
 assert.deepEqual([...h.writes[0].where.id.$in],[1,6]);
 assert.deepEqual(JSON.parse(JSON.stringify(h.writes[0].data)),{isOutOfStock:true});
 assert.equal(h.writes[0].where.updatedAt.$lte,started);
 assert.deepEqual([...h.queries[0].where.category.moyskladId.$in],['sale','child']);
 assert.equal(h.writes[0].where.category,undefined);
 assert.equal(h.writes[0].where.type,'product');assert.equal(h.serial.length,1);
});
test('sync lock, missing category tree, empty matches perform no writes',async()=>{
 for(const options of [{locked:true},{folders:[]},{}]){
  const h=harness(options);assert.equal(await h.hideUnavailableSampleSale(h.app,new Map(),'2026-10-20T11:00:00Z'),0);
  assert.equal(h.writes.length,0);
 }
});
