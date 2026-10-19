const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),cache=new Map();
function load(file){file=path.resolve(root,file.endsWith('.ts')?file:file+'.ts');if(cache.has(file))return cache.get(file).exports;
 const module={exports:{}};cache.set(file,module);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require:n=>n.startsWith('.')?load(path.resolve(path.dirname(file),n)):require(n),process:{env:{}},console},{filename:file});return module.exports;
}
const {prepareCatalogSearchQuery:q,rankCatalogSearchCandidates:rank}=load('src/utils/catalog-search-v2');
const {buildProductSearchFields:index}=load('src/utils/product-search-index');
const {findCatalogSearchCandidates:find}=load('src/utils/catalog-search-v2-candidates');
const {mapCatalogSearchV2Rows:map}=load('src/utils/catalog-search-v2-response');
const {swapSearchLayout,oneSearchEdit}=load('src/utils/catalog-search-language');
const product=(id,name,extra={})=>{const p={id,name,code:'SKU-'+id,...extra};return {...p,...index(p)}};
const ids=rows=>Array.from(rows,r=>r.id);
const forms=[
 ['Шейкер бостон','шейкеры','шейкеров','шейкером'],['Стрейнер','стрейнеры','стрейнеров'],
 ['Бутылочка для биттера','бутылочки для биттеров','бутылочек'],['Барная ложка','барные ложки','барных ложек'],
 ['Пин HoReCa','пины','пинов','значки','значок','pin','pins'],['Джиггер','джиггеры','джиггеров','джигер'],
 ['Силиконовый коврик','силиконовые коврики','ковриков'],['Силиконовая форма','силиконовые формы','силиконовых форм'],
 ['Шпатель кондитерский','шпатели кондитерские','шпателей'],['Сквизер','сквизеры','сквизеров'],
 ['Мадлер','мадлеры','мадлеров'],['Темпер','темперы','тампер'],['Питчер','питчеры','питчеров'],
 ['Пинцет барный','пинцеты','пинцетов'],['Бокал','бокалы','бокалов'],['Стакан','стаканы','стаканов'],
 ['Смесительный стакан','смесительные стаканы'],['Набор бармена','наборы барменов'],
 ['Шпажка бамбуковая','шпажки бамбуковые','шпажками'],['Трубочка','трубочки','трубочкой'],
 ['Нож барный','ножи барные','ножей'],['Венчик','венчики','венчиков'],['Поднос','подносы','подносов'],
 ['Воронка','воронки','воронкой'],['Диспенсер','диспенсеры'],['Мельница','мельницы','мельницей'],
 ['Сифон','сифоны','сифонов'],['Термометр','термометры'],['Рефрактометр','рефрактометры'],
 ['Мерный кувшин','мерные кувшины'],['Крышка для бутылочки','крышки для бутылочек','крышек'],
 ['Формочка для льда','формочки для льда','формочек для льда'],['Кольцо','колец'],['Блюдце','блюдец'],
 ['Лист скелетированный','листья скелетированные','листьев'],['Щипцы для льда','щипцов для льда'],
 // Not a category/synonym dictionary: new arbitrary Russian names work too.
 ['Лабораторная центрифуга','лабораторные центрифуги','лабораторных центрифуг'],
 ['Керамический подсвечник','керамические подсвечники','керамических подсвечников'],
];
for(const [name,...queries] of forms)test('word forms: '+name,()=>{
 const p=product(1,name);for(const term of queries)assert.deepEqual(ids(rank([p],q(term))),[1],term);
});
test('pin synonyms rank actual name before incidental Pink SKU or pincers; similar matches remain',()=>{
 const rows=[product(1,'Листья',{code:'LeafPink100'}),product(2,'Пин HoReCa'),product(3,'Пинцет'),product(4,'Пин Бармены')];
 assert.deepEqual(ids(rank(rows,q('pin'))),[4,2,1]);
 assert.deepEqual(ids(rank(rows,q('пин'))),[4,2,3]);
 assert.deepEqual(ids(rank(rows,q('пины'))),[4,2]);
 assert.deepEqual(ids(rank(rows,q('значки'))),[4,2]);
});
test('keyboard layouts support punctuation and preserve original English/SKU',()=>{
 assert.equal(swapSearchLayout('itqrths'),'шейкеры');assert.equal(swapSearchLayout('kj;rb'),'ложки');
 for(const raw of ['JigV25/40','SKU-123','CD Концепт','ab','123'])assert.equal(swapSearchLayout(raw),null);
 assert.deepEqual(ids(rank([product(1,'Барная ложка')],q('kj;rb'))),[1]);
 assert.deepEqual(ids(rank([product(1,'Шейкер'),product(2,'Товар',{code:'itqrths'})],q('itqrths'))),[2,1]);
 assert.deepEqual(ids(rank([product(1,'Шейкер Koriko')],q('лщкшлщ'))),[1]);
 assert.deepEqual(ids(rank([product(1,'Шейкер'),product(2,'Шейкер',{isSampleSale:true})],q('ewtyrf itqrths'))),[2]);
 assert.deepEqual(ids(rank([product(1,'Шейкер'),product(2,'Шейкер',{isSampleSale:true})],q('ewtyrf'))),[2]);
});
test('one edit includes omission, extra letter, replacement and transposition; no broad guessing',()=>{
 for(const [a,b] of [['стренер','стрейнер'],['шейккер','шейкер'],['шекйер','шейкер'],['шейкнр','шейкер']])assert(oneSearchEdit(a,b));
 assert(!oneSearchEdit('сироп','шейкер'));assert(!oneSearchEdit('стрнер','стрейнер'));
});
test('product type precedes an accessory mentioning it or a shaped souvenir variant',()=>{
 const rows=[product(1,'Брелок',{variants:[{name:'Шейкер'}]}),product(2,'Шейкер бостон'),product(3,'Аксессуар для шейкера')];
 assert.deepEqual(ids(rank(rows,q('шейкеры'))),[2,3,1]);
 assert.equal(rank([product(4,'Полотно для натирки бокалов'),product(5,'Бокал')],q('бокалы'))[0].id,5);
});
// Evaluate just the parameterized searchText predicates; the real Strapi integration tests cover visibility.
function textFilter(where,p){
 if(where.$and)return where.$and.every(w=>textFilter(w,p));if(where.$or)return where.$or.some(w=>textFilter(w,p));
 if(where.searchText)return p.searchText.includes(where.searchText.$containsi);
 if(where.searchCodes)return p.searchCodes.includes(where.searchCodes.$containsi);
 return true;
}
async function search(rows,raw){let calls=0;const query=q(raw),stub={db:{query(){return{findMany:async(args)=>{calls++;return rows.filter(p=>textFilter(args.where,p));}}}}};
 const result=await find(stub,query,new Set());return {query,items:rank(result.candidates,query),calls};}
test('retrieval finds all morphological/layout candidates before pagination without backfill',async()=>{
 for(const [name,...queries] of forms)for(const term of queries){const r=await search([product(1,name)],term);assert.deepEqual(ids(r.items),[1],term);assert.equal(r.calls,1,term);}
 assert.deepEqual(ids((await search([product(1,'Шейкер')],'itqrths')).items),[1]);
});
test('typos use one fallback query and one edited word maximum; exact SKU bypasses guessing',async()=>{
 const rows=[product(1,'Стрейнер'),product(2,'Шейкер бостон'),product(3,'Сироп')];
 for(const raw of ['стренер','стрейнре','сртейнер']){const r=await search(rows,raw);assert.deepEqual(ids(r.items),[1],raw);assert.equal(r.calls,2);}
 assert.deepEqual(ids((await search(rows,'шейкнры бостон')).items),[2]);
 assert.deepEqual(ids((await search(rows,'шейкнры бостнн')).items),[]);
 for(const raw of ['SKU-1','123','пин'])assert.equal((await search(rows,raw)).calls,1);
 assert.equal((await search(rows,'шейкеры')).calls,1);
});
test('word forms and layout select the correct variant including color/price; synonyms never choose Pink',async()=>{
 const row=product(1,'Шейкер',{price:100,variants:[{id:11,name:'Шейкер красный',code:'Red',price:200},{id:12,name:'Шейкер синий',code:'Blue',price:300}]});
 for(const term of ['шейкеры синие','itqrths cbybt']){
  const query=q(term),attrs=map([row],query,{noveltyDays:30},new Set())[0].attributes;
  assert.equal(attrs.matchedVariant.id,12);assert.equal(attrs.matchedVariant.price,300);
 }
 const pin=product(2,'Пин HoReCa',{variants:[{id:22,name:'Розовый',code:'PinPink',price:200}]});
 assert.equal(map([pin],q('pin'),{noveltyDays:30},new Set())[0].attributes.matchedVariant,null);
});
test('bounded filters, no SQL or regex injection, and deterministic full pool',async()=>{
 const rows=Array.from({length:137},(_,i)=>product(i+1,'Керамический подсвечник '+i));
 const a=await search(rows,'керамические подсвечники'),b=await search([...rows].reverse(),'керамических подсвечников');
 assert.equal(a.items.length,137);assert.deepEqual(ids(a.items),ids(b.items));
 const r=await search(rows,"' OR 1=1; --");assert.deepEqual(ids(r.items),[]);assert.equal(r.calls,1);
});
