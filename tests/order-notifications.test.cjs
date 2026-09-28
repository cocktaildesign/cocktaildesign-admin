const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const plain=value=>JSON.parse(JSON.stringify(value));
function loader(globals={}) {
 const cache=new Map();
 function load(file){file=path.resolve(root,file.endsWith('.ts')?file:file+'.ts');if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:n=>n.startsWith('.')?load(path.resolve(path.dirname(file),n)):require(n),Buffer,URL,AbortSignal,Date,process:{env:{}},...globals},{filename:file});return module.exports;
 }return load;
}
const format=loader()('src/api/order-notification/utils/format').formatOrder;
const snapshot=()=>({id:randomUUID(),name:'TEST-17',sum:171000,vatEnabled:true,vatIncluded:true,agent:{name:'Тестовый покупатель',phone:'0000000000'},shipmentAddress:'Тестовый адрес',description:'Юрлицо | Telegram: @example | ИНН: 000000000000 | Гравировка: Джиггер | Промокод TEST: 10% | Комментарий: тест'});
const positions=()=>[{quantity:2,price:45000,discount:10,vat:5,assortment:{name:'Джиггер',code:'Jig20\\40',characteristics:[{name:'Объём',value:'20/40 мл'}]}},{quantity:1,price:100000,discount:10,vat:5,assortment:{name:'Шейкер',code:'Sh01'}}];
test('notification uses CRM total, labels original prices, includes options and buyer details',()=>{
 const result=format(snapshot(),positions()).join('\n');
 assert.match(result,/<b>Новый заказ №TEST-17<\/b>/);assert.match(result,/2 × 450 ₽ = 900 ₽/);
 assert.match(result,/Скидка: 10%/);assert.match(result,/Артикул: Jig20\\40/);assert.match(result,/Объём: 20\/40 мл/);
 assert.match(result,/Сумма заказа: 1\s710 ₽/);assert.match(result,/Скидка по заказу: 190 ₽/);
 assert.match(result,/НДС 5%/);assert.match(result,/Гравировка: Джиггер/);assert.match(result,/Юрлицо/);assert.match(result,/не подтверждение оплаты/);
});
test('HTML injection in products, contact fields, comment and order name is escaped',()=>{
 const order=snapshot();order.name='<x>&';order.agent.name='<b>Buyer</b>';order.description='<a href="https://bad.test">click</a>';
 const rows=positions();rows[0].assortment.name='<script>name</script>';
 const text=format(order,rows).join('\n');assert(!text.includes('<script>'));assert(!text.includes('<a href'));assert(text.includes('&lt;script&gt;'));assert(text.includes('&lt;b&gt;Buyer&lt;/b&gt;'));
});
test('long orders preserve every item and special characters in bounded numbered messages',()=>{
 const rows=Array.from({length:100},(_,i)=>({quantity:1,price:100,discount:0,vat:5,assortment:{name:`ITEM-${i}-`+'😀&'.repeat(170),code:`SKU-${i}`}}));
 const o=snapshot();o.description='&'.repeat(2000);const messages=format(o,rows);
 assert(messages.length>1 && messages.length<=100);assert(messages.every(m=>m.length<=3800 && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(m)));
 for(let i=0;i<100;i++)assert(messages.join('\n').includes(`Артикул: SKU-${i}`));
 messages.forEach((m,i)=>assert(m.startsWith(`<b>Новый заказ №TEST-17</b> · ${i+1}/${messages.length}`)));
});
test('notification rejects incomplete or invalid pricing instead of inventing a total',()=>{
 assert.throws(()=>format({...snapshot(),sum:undefined},positions()));assert.throws(()=>format(snapshot(),[]));
 assert.throws(()=>format(snapshot(),[{...positions()[0],price:NaN}]));assert.throws(()=>format(snapshot(),[{...positions()[0],assortment:{}}]));
});
function matches(row,where){return Object.entries(where).every(([key,c])=>key==='$or'?c.some(v=>matches(row,v)):c===null?row[key]==null:c&&typeof c==='object'?Object.entries(c).every(([op,v])=>op==='$null'?row[key]==null:op==='$lte'?row[key]!=null&&new Date(row[key])<=new Date(v):false):row[key]===c);}
function fixture(){
 const rows=[],source=[],requests=[];let failCRM=false,failCreate=false;const env={ORDER_NOTIFICATIONS_ENABLED:'true',ORDER_NOTIFICATIONS_FROM_REQUEST_ID:'10',FEEDBACK_WORKER_TOKEN:'isolated-token-for-order-notifications',MOYSKLAD_ACCESS_TOKEN:'isolated-dummy'};
 const db={async findOne({where}){return plain(rows.find(r=>matches(r,where))||null)},async updateMany({where,data}){const found=rows.filter(r=>matches(r,where));found.forEach(r=>Object.assign(r,plain(data)));return{count:found.length}}};
 const strapi={db:{query(uid){assert.equal(uid,'api::order-notification.order-notification');return db},connection(table){assert.equal(table,'order_requests as r');const clauses=[];return{leftJoin(){return this},where(...a){clauses.push(a);return this},whereNull(){return this},whereNotNull(){return this},orderBy(){return this},select(){return this},async first(){assert(clauses.some(a=>a[0]==='r.status'&&a[1]==='succeeded'));return source.find(r=>r.status==='succeeded'&&r.id>Number(env.ORDER_NOTIFICATIONS_FROM_REQUEST_ID)&&!rows.some(n=>n.orderId===r.order_id))}}}},
 documents(){return{async create({data}){if(failCreate)throw Error('DB failed');if(rows.some(r=>r.orderId===data.orderId))throw Error('unique');const row={id:rows.length+1,leaseToken:null,nextAttemptAt:null,createdAt:new Date(),...data};rows.push(row);return row}}},log:{warn(){},error(){}}};
 const order=snapshot();
 const fetch=async(url,options)=>{requests.push({url,options});assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert(options.signal);if(failCRM)return new Response('{}',{status:429});return new Response(JSON.stringify(url.includes('/positions?')?{rows:positions(),meta:{size:2}}:{...order,id:url.split('/customerorder/')[1].split('?')[0]}));};
 const load=loader({strapi,fetch,process:{env}});const q=load('src/api/order-notification/utils/queue');
 function add(id,status='succeeded'){const r={id,status,order_id:randomUUID(),order_name:'TEST-'+id};source.push(r);return r;}
 return {q,load,rows,source,requests,env,add,setCRMFailure(v){failCRM=v},setDBFailure(v){failCreate=v}};
}
test('discovery ignores historical/processing orders and never touches the checkout records',async()=>{
 const f=fixture();f.add(9);f.add(11,'processing');const r=f.add(12);const before=plain(f.source);
 await f.q.discoverOrder();await f.q.discoverOrder();assert.equal(f.rows.length,1);assert.equal(f.rows[0].orderId,r.order_id);assert.deepEqual(plain(f.source),before);assert.equal(f.requests.length,0);
});
test('disabled or missing watermark cannot discover or send historical orders',async()=>{
 const f=fixture();f.add(12);delete f.env.ORDER_NOTIFICATIONS_FROM_REQUEST_ID;assert.equal(f.q.enabled(),false);assert.equal(await f.q.claimOrder(),null);assert.equal(f.rows.length,0);assert.equal(f.requests.length,0);
});
test('one lease per order, frozen snapshot, stale acknowledgements rejected and successful ack replayed',async()=>{
 const f=fixture();await f.q.discoverOrder();f.add(12);await f.q.discoverOrder();const before=plain(f.source);
 const found=await Promise.all([f.q.claimOrder(),f.q.claimOrder()]);const items=found.filter(Boolean);assert.equal(items.length,1);assert.equal(f.requests.length,2);
 const item=items[0];assert.equal(await f.q.completeOrder({id:item.id,leaseToken:randomUUID(),ok:true,messageIds:['42']}),false);
 assert.equal(await f.q.completeOrder({id:item.id,leaseToken:item.leaseToken,ok:false,error:'telegram_unavailable',retryAfter:1}),true);
 f.rows[0].nextAttemptAt=new Date(0).toISOString();const retry=await f.q.claimOrder();assert.deepEqual(plain(retry.messages),plain(item.messages));assert.equal(f.requests.length,2);
 const done={id:item.id,leaseToken:retry.leaseToken,ok:true,messageIds:retry.messages.map((_,i)=>String(i+42))};
 assert.equal(await f.q.completeOrder(done),true);assert.equal(await f.q.completeOrder(done),true);assert.deepEqual(plain(f.source),before);
});
test('CRM 429 leaves a retryable notification; all CRM requests are GET and checkout remains unchanged',async()=>{
 const f=fixture();f.add(12);const before=plain(f.source);f.setCRMFailure(true);assert.equal(await f.q.claimOrder(),null);
 assert.equal(f.rows[0].notificationStatus,'pending');assert.equal(f.rows[0].deliveryError,'crm_rate_limit');assert(f.rows[0].nextAttemptAt);assert.deepEqual(plain(f.source),before);
});
test('retry limit stops repeated failing deliveries without deleting the notification',async()=>{
 const f=fixture();f.add(12);await f.q.discoverOrder();Object.assign(f.rows[0],{attempts:8});assert.equal(await f.q.claimOrder(),null);assert.equal(f.rows[0].notificationStatus,'failed');assert.equal(f.rows.length,1);assert.equal(f.requests.length,0);
});
test('unauthorized worker cannot discover/read customer orders',async()=>{
 const f=fixture();f.add(12);const controller=f.load('src/api/order-notification/controllers/order-notification').default;
 const ctx={set(){},get(){return'Bearer invalid'},request:{body:{}}};await controller.claim(ctx);assert.equal(ctx.status,401);assert.equal(f.rows.length,0);assert.equal(f.requests.length,0);
});
test('completion validates id, full message list and lease',()=>{
 const f=fixture();assert.equal(f.q.validateCompletion({id:1,leaseToken:randomUUID(),ok:true,messageIds:[]}),null);
 assert.equal(f.q.validateCompletion({id:1,leaseToken:randomUUID(),ok:true,messageIds:['fake']}),null);
 assert(f.q.validateCompletion({id:1,leaseToken:randomUUID(),ok:true,messageIds:['42']}));
});
