const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('typescript');
const mod={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/utils/homepage-banners.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module:mod,exports:mod.exports,require:id=>{assert.equal(id,'@strapi/utils');return {errors:{ValidationError:Error}}}});
function fixture(existing,files={1:{id:1,mime:'image/webp',size:80}}){let middleware;const docs=()=>({findOne:async()=>existing});docs.use=fn=>middleware=fn;mod.exports.registerHomepageBannerValidation({documents:docs,db:{query:()=>({findOne:async({where})=>files[where.id]})}});return (data,action='publish')=>middleware({uid:'api::homepage.homepage',action,params:{documentId:'home',data}},async()=> 'passed');}
const legacy={title:'Legacy',desktopImage:1,mobileImage:1,href:'/catalog'};
const editorial={title:'Editorial',useTextLayout:true,heading:'Заголовок',buttonLabel:'Каталог',productImage:1,href:'/catalog'};
test('published legacy and editorial slides validate only their chosen media',async()=>{
 const validate=fixture({heroBanners:[legacy],promoBanners:[legacy]});
 assert.equal(await validate({heroBanners:[editorial]}),'passed');
 assert.equal(await validate({heroBanners:[legacy]}),'passed');
 assert.equal(await validate({heroBanners:[{...editorial,href:'',buttonLabel:''}]}),'passed');
});
test('incomplete drafts remain editable; publish prevents missing photo/headline/button',async()=>{
 const validate=fixture({heroBanners:[editorial]});
 for(const change of [{heading:''},{buttonLabel:''},{productImage:null}]){
  const data={heroBanners:[{...editorial,...change}]};
  assert.equal(await validate(data,'update'),'passed');
  await assert.rejects(validate(data));
 }
 await assert.rejects(validate({heroBanners:[{...legacy,mobileImage:null}]}));
});
test('publish revalidates stored draft and rejects unsafe destinations, files and oversized groups',async()=>{
 await assert.rejects(fixture({heroBanners:[{...editorial,productImage:null}]})(undefined));
 await assert.rejects(fixture({heroBanners:[editorial]},{1:{mime:'image/svg+xml',size:1}})(undefined));
 await assert.rejects(fixture({heroBanners:[editorial]},{1:{mime:'image/webp',size:2049}})(undefined));
 await assert.rejects(fixture({heroBanners:[{...editorial,href:'javascript:alert(1)'}]})(undefined));
 await assert.rejects(fixture({heroBanners:Array(7).fill(editorial)})(undefined));
});
