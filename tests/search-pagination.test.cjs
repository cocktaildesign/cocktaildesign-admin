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
test('photos precede photo-less exact name matches and ordinary products across the full result pool',()=>{
 const noPhoto=product(1,'Шейкер');
 const rows=[noPhoto,...Array.from({length:23},(_,i)=>product(i+2,'Шейкер '+i,{hasSearchImage:true,isSampleSale:i>19}))];
 const ordered=rank(rows,q('шейкер'));
 assert.equal(ordered.length,24);assert.equal(ordered.at(-1).id,1);
 assert.ok(ordered.slice(0,23).every(p=>p.hasSearchImage));
 assert.equal(rank([noPhoto],q('шейкер'))[0].id,1);
});
test('photo priority preserves previous relevance and markdown ordering inside each photo group',()=>{
 const rows=[product(1,'Шейкер Б',{hasSearchImage:true}),product(2,'Шейкер А',{hasSearchImage:true,isSampleSale:true}),
 product(3,'Шейкер А'),product(4,'Шейкер Б',{isSampleSale:true}),product(5,'Шейкер',{hasSearchImage:true,isSampleSale:true})];
 assert.deepEqual(ids(rank(rows,q('шейкер'))),[5,1,2,3,4]);
 assert.deepEqual(ids(rank(rows.reverse(),q('шейкер'))),[5,1,2,3,4]);
});
test('candidate photo presence includes variant fallback and does not treat empty media as a photo',async()=>{
 const {findCatalogSearchCandidates:find}=load('src/utils/catalog-search-v2-candidates');
 const rows=[product(1,'Шейкер'),product(2,'Шейкер',{image:[]}),product(3,'Шейкер',{image:[{url:'/uploads/p.webp'}]}),
 product(4,'Шейкер',{variants:[{name:'Цвет',image:[{url:'/uploads/v.webp'}]}]}),
 product(5,'Шейкер',{image:[{url:null}],variants:[{name:'Цвет',image:[]}]})];
 const stub={db:{query(){return {findMany:async(args)=>{assert.ok(args.populate.variants.select.includes('code'));return rows}}}}};
 const result=await find(stub,q('шейкер'),new Set());
 assert.deepEqual(Array.from(result.candidates,p=>p.hasSearchImage),[false,false,true,true,false]);
 assert.deepEqual(ids(rank(result.candidates,q('шейкер'))),[3,4,1,2,5]);
});
test('malformed paging fails before touching database',async()=>{
 const {getCatalogSearchPage:page}=load('src/utils/catalog-search-v2-page');
 const noDB=new Proxy({}, {get(){throw Error('DB must not be queried')}});
 for(const args of [{q:'шейкер',limit:'0'},{q:'шейкер',offset:'-1'},{q:'шейкер',limit:'51'},{q:['a','b']},{q:'x'.repeat(161)},{q:'шейкер',revision:'bad'}])assert.equal((await page(noDB,args)).status,400);
 assert.equal((await page(noDB,{q:'я'})).body.total,0);
});

test('literal SKU wins for either slash direction, with all similar products retained',()=>{
 const rows=[product(65,'Джиггер Creation без кольца',{code:'JigV25\\40',hasSearchImage:true}),
  product(201,'Джиггер V-тип',{code:'JigV25/40',hasSearchImage:true}),
  product(1779,'Джиггер уцененный',{code:'SMPLJigV25/40',hasSearchImage:true,isSampleSale:true})];
 assert.deepEqual(ids(rank(rows,q('JigV25/40'))),[201,65,1779]);
 assert.deepEqual(ids(rank(rows,q('JigV25\\40'))),[65,201,1779]);
 assert.deepEqual(ids(rank(rows.reverse(),q('  jigv25/40  '))),[201,65,1779]);
});
test('literal SKU takes precedence over photo and markdown rules, even beyond the first page',()=>{
 const rows=Array.from({length:25},(_,i)=>product(i+1,'Джиггер '+i,{code:'ALT-'+i+'-JIG25/40',hasSearchImage:true}));
 const exact=product(100,'Джиггер уцененный',{code:'JIG25/40',isSampleSale:true});
 const result=rank([...rows,exact],q('JIG25/40'));
 assert.equal(result[0].id,100);assert.equal(new Set(ids(result)).size,26);
 assert.deepEqual(ids(result.slice(1)),ids(rank(rows,q('JIG25/40'))));
});
test('literal SKU preserves punctuation, internal spaces and Latin/Cyrillic distinctions',()=>{
 const rows=[product(1,'А',{code:'AB12'}),product(2,'Б',{code:'AB-12'}),product(3,'В',{code:'AB 12'}),product(4,'Г',{code:'АВ12'})];
 for(const [query,id] of [['AB12',1],['AB-12',2],['AB 12',3],['АВ12',4]]){
  const result=rank(rows,q(query));assert.equal(result[0].id,id);assert.equal(result.length,4);
 }
});
test('a literal variant SKU ranks ahead of a normalized parent SKU',()=>{
 const rows=[product(1,'А',{code:'JIG25\\40',hasSearchImage:true}),
  product(2,'Б',{variants:[{name:'Б вариант',code:'JIG25/40'}]})];
 assert.deepEqual(ids(rank(rows,q('JIG25/40'))),[2,1]);
});
test('the response shows the literal variant with its own ID and price, retaining fuzzy fallback',()=>{
 const {mapCatalogSearchV2Rows:map}=load('src/utils/catalog-search-v2-response');
 const variants=[{id:10,name:'Без кольца',code:'JIG25\\40',price:600},
  {id:11,name:'С кольцом',code:'JIG25/40',price:650}];
 const row={id:1,name:'Джиггер',code:'PARENT',variants};
 const read=(code,p=row)=>map([p],q(code),{noveltyDays:30,noveltyBadgeColor:'#00ff00'},new Set())[0].attributes;
 assert.equal(read('JIG25/40').matchedVariant.id,11);assert.equal(read('JIG25/40').matchedVariant.price,650);
 assert.equal(read('JIG25\\40').matchedVariant.id,10);
 assert.equal(read('JIG2540').matchedVariant.id,10);
 assert.equal(read('JIG25/40',{...row,code:'JIG25/40',variants:[variants[0]]}).matchedVariant,null);
});
