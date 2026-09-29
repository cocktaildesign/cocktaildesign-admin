const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),cache=new Map();
function load(file){file=path.resolve(root,file.endsWith('.ts')?file:file+'.ts');if(cache.has(file))return cache.get(file).exports;
 const module={exports:{}};cache.set(file,module);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require:n=>n.startsWith('.')?load(path.resolve(path.dirname(file),n)):require(n),process:{env:{}},console},{filename:file});return module.exports;
}
const {prepareCatalogSearchQuery:q,rankCatalogSearchCandidates:rank}=load('src/utils/catalog-search-v2');
const {buildProductSearchFields:index}=load('src/utils/product-search-index');
const product=(id,name,extra={})=>{const p={id,name,code:'SKU-'+id,...extra};return {...p,...index(p)}};
const ids=rows=>Array.from(rows,r=>r.id);
test('general search: normal products before markdown, relevance then alphabetical and stable ID ties',()=>{
 const rows=[product(90,'Шейкер Б', {isSampleSale:true}),product(9,'Шейкер Б'),product(1,'Шейкер А'),product(8,'Шейкер А')];
 assert.deepEqual(ids(rank(rows,q('шейкер'))),[1,8,9,90]);assert.deepEqual(ids(rank([...rows].reverse(),q('шейкер'))),[1,8,9,90]);
});
test('exact SKU and variant SKU override markdown group; normalized punctuation and lookalikes survive',()=>{
 const exact=product(1,'Джиггер (уцененный)',{isSampleSale:true,code:'JigB30\\60'});
 const normal=product(2,'JigB30 60 аксессуар');assert.equal(rank([normal,exact],q('JigB30/60'))[0].id,1);
 const variant=product(3,'Джиггер Barsoul',{variants:[{name:'Джиггер серебро',code:'JigB30\\60'}],isSampleSale:true});
 assert.equal(rank([normal,variant],q('JigB30/60'))[0].id,3);
});
test('exact product/variant names win, including markdown',()=>{
 const exact=product(1,'Шейкер Классик',{isSampleSale:true}),other=product(2,'Шейкер Классик большой');
 assert.equal(rank([other,exact],q('Шейкер Классик'))[0].id,1);
 const variant=product(3,'Шейкер',{isSampleSale:true,variants:[{name:'Шейкер Классик'}]});
 assert.equal(rank([other,variant],q('Шейкер Классик'))[0].id,3);
});
test('explicit markdown and partial words remain searchable',()=>{
 const normal=product(1,'Барная ложка'),sale=product(2,'Барная ложка',{isSampleSale:true});
 assert.deepEqual(ids(rank([normal,sale],q('уценённые'))),[2]);
 assert.deepEqual(ids(rank([normal,sale],q('уценка барная'))),[2]);
 assert.deepEqual(ids(rank([normal,sale],q('барн лож'))),[1,2]);
});
test('matching pool is not capped at 10 or 80',()=>{
 const rows=Array.from({length:127},(_,i)=>product(i+1,'Шейкер '+(i+1)));
 assert.equal(rank(rows,q('шейкер')).length,127);assert.deepEqual(ids(rank(rows,q('шейкер'))),rows.map(r=>r.id));
});
test('malformed paging fails before touching database',async()=>{
 const {getCatalogSearchPage:page}=load('src/utils/catalog-search-v2-page');
 const noDB=new Proxy({}, {get(){throw Error('DB must not be queried')}});
 for(const args of [{q:'шейкер',limit:'0'},{q:'шейкер',offset:'-1'},{q:'шейкер',limit:'51'},{q:['a','b']},{q:'x'.repeat(161)},{q:'шейкер',revision:'bad'}])assert.equal((await page(noDB,args)).status,400);
 assert.equal((await page(noDB,{q:'я'})).body.total,0);
});
