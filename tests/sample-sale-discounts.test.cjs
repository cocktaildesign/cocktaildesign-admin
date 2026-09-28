const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const SAMPLE = 'b4121850-6ab7-11ef-0a80-01fa00116171';
const tiers = [[10000,5],[25000,8],[50000,12],[100000,16],[200000,20]].map(([minAmount,percent])=>({minAmount,percent}));
const plain = value => JSON.parse(JSON.stringify(value));

// Every database and HTTP operation is an in-memory fake. No production env or bootstrap is loaded.
function fixture() {
  const state = { requests: new Map(), posts: [], categoryReads: 0, failure: '', promosUsed: 0 };
  const categories = [
    {id:1,moyskladId:SAMPLE,parent:null}, {id:2,moyskladId:'sample-child',parent:{id:1}},
    {id:3,moyskladId:'sample-grandchild',parent:{id:2}}, {id:4,moyskladId:'ordinary',parent:null},
  ];
  const make = (code,price,folder='ordinary',discountExcluded=false)=>({code,id:code,name:code,price,discountExcluded,
    category:{moyskladId:folder},href:'https://example.invalid/product/'+code,type:'product',isHiddenOnSite:false,isOutOfStock:false});
  const products = [make('REG',10000),make('SALE',5000,SAMPLE),make('CHILD',1000,'sample-grandchild'),
    make('MANUAL',1000,'ordinary',true),make('HIDDEN',1000,SAMPLE),make('BUNDLE',2000)];
  products.find(p=>p.code==='HIDDEN').isHiddenOnSite=true;
  products.find(p=>p.code==='BUNDLE').type='bundle';
  const variants = [{code:'VAR',id:100,name:'variant',price:700,href:'https://example.invalid/variant/VAR',product:products[2]}];
  const promos = Object.fromEntries([['PERCENT','percent',10],['STARTUP','startup',10],['MONEY','fixed',1000],['GIFT','inventory',0]]
    .map(([code,discountType,discountValue],id)=>[code,{id,code,discountType,discountValue,isActive:true,usageCount:0}]));
  const visible = p=>p&&!p.isHiddenOnSite&&!p.isOutOfStock;
  const strapi = {log:{info(){},warn(){},error(){}},db:{
    query(uid) {
      if(uid.includes('moysklad-category')) return {findMany:async()=>{state.categoryReads++;return categories;}};
      if(uid.includes('discount-tier')) return {findMany:async()=>tiers};
      if(uid.includes('promo-code')) return {findOne:async({where})=>promos[where.code]??null};
      if(uid.includes('order-request')) return {
        findOne:async({where})=>state.requests.get(where.idempotencyKey)??null,
        create:async({data})=>{const row={id:state.requests.size+1,...data};state.requests.set(data.idempotencyKey,row);return row;},
        delete:async({where})=>{for(const [key,row] of state.requests)if(row.id===where.id)state.requests.delete(key);},
      };
      const isVariant=uid.includes('moysklad-variant');
      if(!isVariant&&!uid.includes('moysklad-product')) throw Error('Unexpected DB query '+uid);
      const rows=isVariant?variants:products;
      return {
        findOne:async(args)=>{
          assert(isVariant?args.populate.product.populate.category:args.populate.category,'category must be selected');
          return rows.find(p=>p.code===args.where.code)??null;
        },
        findMany:async(args)=>rows.filter(p=>args.where.code.$in.includes(p.code)&&visible(isVariant?p.product:p)),
      };
    },
    async transaction(fn) {
      const trx=table=>({where:({id})=>({update:async(data)=>{
        if(table==='promo_codes'){state.promosUsed++;return 1;}
        assert.equal(table,'order_requests');
        const row=[...state.requests.values()].find(r=>r.id===id);
        if(!row)return 0;
        Object.assign(row,{status:data.status,orderId:data.order_id,orderName:data.order_name});return 1;
      }})});
      trx.raw=()=>0;
      await fn({trx});
    },
  }};
  const mockFetch=async(url,options)=>{
    assert.equal(options.method,'POST','Unexpected HTTP method; real network is unavailable');
    state.posts.push({url,body:JSON.parse(options.body)});
    if(url.endsWith('/entity/counterparty')) {
      if(state.failure==='counterparty') throw Error('simulated connection failure');
      return {ok:true,json:async()=>({meta:{href:'https://example.invalid/customer/test'}})};
    }
    assert(url.endsWith('/entity/customerorder'),'Unexpected HTTP target');
    if(state.failure==='timeout')throw Object.assign(new Error('simulated timeout'),{name:'AbortError'});
    return {ok:true,json:async()=>({id:'offline-order',name:'OFFLINE-TEST'})};
  };
  const context=vm.createContext({strapi,fetch:mockFetch,process:{env:{}},AbortController,setTimeout,clearTimeout,console});
  const cache=new Map();
  function load(file) {
    file=path.resolve(root,file);
    assert(file.startsWith(root+path.sep));
    if(cache.has(file))return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);
    const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const localRequire=id=>{
      if(id==='@strapi/strapi')return {factories:{createCoreService:(_uid,fn)=>fn({strapi})}};
      assert(id.startsWith('.'),'Non-local dependency blocked: '+id);
      return load(path.resolve(path.dirname(file),id+'.ts'));
    };
    vm.runInContext('(function(require,module,exports){'+source+'\n})',context,{timeout:1000})(localRequire,module,module.exports);
    return module.exports;
  }
  const service=load('src/api/order/services/order.ts').default;
  const promo=load('src/api/promo-code/services/promo-code.ts').default;
  strapi.service=uid=>{assert.equal(uid,'api::promo-code.promo-code');return promo;};
  const controller=load('src/api/order/controllers/order.ts').default;
  const policy=load('src/api/moysklad-category/controllers/cart-discount-policy.ts').default;
  async function order(codes,promoCode,key='offline-test-key-1234') {
    const ctx={request:{body:{buyerType:'individual',fullName:'Offline test',phone:'0000000000',address:'Test only',promoCode,
      items:codes.map(code=>({code,quantity:1,price:1,discountExcluded:false}))}},get:()=>key};
    await controller.create(ctx);return plain({status:ctx.status??200,body:ctx.body});
  }
  async function flags(codes){const ctx={query:{codes:JSON.stringify(codes)},set(){}};await policy.find(ctx);return plain(ctx.body);}
  return {state,products,variants,service,promo,order,flags,policy};
}

test('catalog policy handles category descendants, variants, manual exclusions and category moves',async()=>{
  const f=fixture();
  assert.deepEqual((await f.flags(['REG','SALE','CHILD','VAR','MANUAL','HIDDEN','BUNDLE'])).items,
    [['REG',false],['SALE',true],['CHILD',true],['VAR',true],['MANUAL',true],['BUNDLE',false]].map(([code,discountExcluded])=>({code,discountExcluded})));
  f.products[0].category.moyskladId='sample-child';
  assert.equal((await f.flags(['REG'])).items[0].discountExcluded,true);
  f.products[0].category.moyskladId='ordinary';
  assert.equal((await f.flags(['REG'])).items[0].discountExcluded,false);
  assert.equal(f.state.posts.length,0);
});

test('saved-cart endpoint rejects malformed and oversized batches without queries',async()=>{
  const f=fixture();
  for(const value of ['not-json','{}','[]',JSON.stringify(Array(26).fill('REG')),JSON.stringify(['']),JSON.stringify([1])]){
    const ctx={query:{codes:value}};await f.policy.find(ctx);assert.equal(ctx.status,400);
  }
  assert.equal(f.state.categoryReads,0);
});

test('mixed order trusts database price/policy and sends zero volume discount for sample-sale',async()=>{
  const f=fixture(); const result=await f.order(['REG','SALE']);assert(result.body.ok);
  const payload=f.state.posts[1].body;
  assert.deepEqual(payload.positions.map(p=>[p.price,p.discount]),[[1000000,5],[500000,0]]);
  assert.match(payload.description,/14500/);
  assert.equal(f.state.categoryReads,1,'one tree read per whole order');
  const replay=await f.order(['REG','SALE']);assert(replay.body.replayed);assert.equal(f.state.posts.length,2);
});

for(const code of ['PERCENT','STARTUP','MONEY','GIFT'])test(code+' respects the agreed exception for fixed money',async()=>{
  const f=fixture(); assert((await f.order(['REG','SALE'],code)).body.ok);
  const positions=f.state.posts[1].body.positions;
  if(code==='MONEY')assert(positions[1].discount>0);
  else assert.equal(positions[1].discount,0);
  assert.equal(positions[0].discount,code==='GIFT'?5:code==='MONEY'?11.5517:10);
});

test('sample-sale only: percentage gives zero, fixed money remains usable and capped',async()=>{
  const f=fixture();
  const percent=await f.promo.resolvePromoCode('PERCENT',5000,0);assert.equal(percent.discountAmount,0);
  const fixed=await f.promo.resolvePromoCode('MONEY',5000,0);assert.equal(fixed.discountAmount,1000);
  const small=await f.promo.resolvePromoCode('MONEY',400,0);assert.equal(small.discountAmount,400);
  assert((await f.order(['SALE'],'MONEY')).body.ok);
  assert.equal(f.state.posts[1].body.positions[0].discount,20);
});

test('all volume boundaries use total basket while applying only to eligible items',async()=>{
  const f=fixture();
  for(const tier of tiers)for(const amount of [tier.minAmount-1,tier.minAmount,tier.minAmount+1]){
    const expected=tiers.filter(t=>t.minAmount<=amount).at(-1)?.percent??0;
    const percent=await f.service.resolveVolumeDiscountPercent(amount);assert.equal(percent,expected);
    const plan=f.service.resolveOrderDiscountPlan({totalPrice:amount,discountableTotal:amount/2,volumeDiscountPercent:percent,promo:null});
    assert.equal(plan.appliedVolumeDiscountAmount,Math.round(amount/2*expected/100));
    assert.equal(plan.excludedPositionPercent,0);
  }
});

test('variant inherits parent policy; bundle and manual exclusion keep existing prices',async()=>{
  const f=fixture();
  assert.equal((await f.service.resolveOrderItemByCode('VAR')).trustedDiscountExcluded,true);
  assert.equal((await f.service.resolveOrderItemByCode('BUNDLE')).trustedPriceRub,2000);
  assert.equal((await f.service.resolveOrderItemByCode('MANUAL')).trustedDiscountExcluded,true);
  f.products[1].price=4200;
  assert.equal((await f.service.resolveOrderItemByCode('SALE')).trustedPriceRub,4200);
  await assert.rejects(f.service.resolveOrderItemByCode('HIDDEN'),error=>error.code==='item_not_found');
});

test('CRM timeout stays unknown and retry cannot create another order',async()=>{
  const f=fixture();f.state.failure='timeout';
  assert.equal((await f.order(['REG','SALE'])).body.error,'order_status_unknown');
  assert.equal((await f.order(['REG','SALE'])).status,409);assert.equal(f.state.posts.length,2);
});

test('pre-order CRM failure releases request without creating order',async()=>{
  const f=fixture();f.state.failure='counterparty';
  assert.equal((await f.order(['REG','SALE'])).body.error,'order_validation_failed');
  assert.equal(f.state.requests.size,0);assert.equal(f.state.posts.length,1);
});
