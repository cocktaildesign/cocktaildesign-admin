const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/api/site-order-journal/utils/analytics.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const mod = {exports:{}};
vm.runInNewContext(code,{module:mod,exports:mod.exports}); // No database, HTTP, filesystem or environment available.
const read = value => {const out=mod.exports.purchaseAnalytics(value);return out && JSON.parse(JSON.stringify(out));};
const snapshot = () => ({version:1,order:{sum:225099,agent:{name:'PRIVATE',phone:'PRIVATE'},description:'PRIVATE',shipmentAddress:'PRIVATE'},
  positions:[{quantity:2,price:100050,discount:10,assortment:{code:'Jig25/40',name:'Джиггер 25/40 мл',href:'PRIVATE'}},
    {quantity:1,price:45000,discount:0,assortment:{code:'SALE',name:'Уценка'}}]});

test('commerce uses the authoritative receipt total and discounted line prices, with only allowed fields',()=>{
  const source=snapshot(),before=JSON.stringify(source),out=read(source);
  assert.deepEqual(out,{currency:'RUB',revenue:2250.99,products:[
    {id:'Jig25/40',name:'Джиггер 25/40 мл',price:900.45,quantity:2},
    {id:'SALE',name:'Уценка',price:450,quantity:1}]});
  assert.equal(JSON.stringify(source),before);assert(!JSON.stringify(out).includes('PRIVATE'));
  assert.deepEqual(read(JSON.stringify(source)),out);
});

test('gift/free items and 100 item baskets are valid and preserve variant SKU separators',()=>{
  const source=snapshot();source.order.sum=0;source.positions=[{...source.positions[0],discount:100}];
  assert.equal(read(source).products[0].price,0);assert.equal(read(source).revenue,0);
  source.positions=Array.from({length:100},(_,i)=>({...source.positions[0],assortment:{code:'Variant\\'+i,name:'Вариант '+i}}));
  assert.equal(read(source).products.length,100);assert.equal(read(source).products[99].id,'Variant\\99');
});

test('missing or malformed analytics never blocks a receipt, and never invents prices',()=>{
  for(const value of [undefined,null,'{broken}',{}, {version:1,order:{sum:100},positions:[]},
      {...snapshot(),version:2},{...snapshot(),order:{sum:1.5}},{...snapshot(),order:{sum:-1}},
      {...snapshot(),order:{sum:Number.MAX_SAFE_INTEGER+1}}]) assert.equal(read(value),undefined);
  for(const patch of [{quantity:0},{quantity:1.5},{price:NaN},{price:Infinity},{price:-1},{discount:101},
      {discount:-1},{price:undefined},{quantity:undefined},{assortment:{name:'Missing SKU'}}, {assortment:{code:'SKU'}}]) {
    const source=snapshot();Object.assign(source.positions[0],patch);assert.equal(read(source),undefined);
  }
  assert.equal(read(new Proxy({}, {get(){throw Error('unreadable');}})),undefined);
});
