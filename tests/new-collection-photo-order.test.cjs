const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const modulePath=path.resolve(__dirname,'../src/utils/new-collection-photo-order.ts');
const compiled=ts.transpileModule(fs.readFileSync(modulePath,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const loaded={exports:{}};vm.runInNewContext(compiled,{module:loaded,exports:loaded.exports});
const {getNewCollectionPhotoPage:page}=loaded.exports;
const photo=[{url:'/uploads/photo.webp'}];
function harness(rows){const calls=[],where={isHiddenOnSite:false},order=[{moyskladNoveltyAt:'desc'},{id:'desc'}];return {calls,read:async(limit,offset)=>page({findMany:async opts=>{assert.equal(opts.where,where);assert.equal(opts.orderBy,order);calls.push(opts);return rows.slice(opts.offset,opts.offset+opts.limit)}},where,order,limit,offset)};}
test('photo groups preserve novelty order including variant fallback, null and empty images',async()=>{
 const rows=[{id:9},{id:8,image:photo},{id:7,image:[],variants:[{image:photo}]},{id:6,image:null},{id:5,image:photo},{id:4,image:[{url:null}]}];
 const h=harness(rows),r=await h.read(20,0);assert.deepEqual(Array.from(r.ids),[8,7,5,9,6,4]);assert.equal(r.total,6);
 assert.deepEqual(rows.map(r=>r.id),[9,8,7,6,5,4]);
});
test('all pages use the complete photo partition beyond the 200-row query batch',async()=>{
 const rows=Array.from({length:413},(_,i)=>({id:500-i,...(i%3?{image:photo}:{})}));
 const expected=[...rows.filter(r=>r.image),...rows.filter(r=>!r.image)].map(r=>r.id),h=harness(rows),ids=[];
 for(let offset=0;offset<413;offset+=24){const p=await h.read(24,offset);assert.equal(p.total,413);ids.push(...p.ids);}
 assert.deepEqual(ids,expected);assert.equal(new Set(ids).size,413);
 const tail=await h.read(24,999);assert.equal(tail.total,413);assert.equal(tail.ids.length,0);
});
test('empty collections and photo changes keep membership while updating the next read',async()=>{
 assert.equal((await harness([]).read(24,0)).total,0);
 const rows=[{id:3},{id:2,image:photo},{id:1}],h=harness(rows);
 assert.deepEqual(Array.from((await h.read(24,0)).ids),[2,3,1]);
 rows[0].image=photo;assert.deepEqual(Array.from((await h.read(24,0)).ids),[3,2,1]);
 rows[1].image=[];assert.deepEqual(Array.from((await h.read(24,0)).ids),[3,2,1]);
});
