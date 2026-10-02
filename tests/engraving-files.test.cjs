const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Readable}=require('node:stream'),{randomUUID}=require('node:crypto');
const {EngravingStorage,validateFile,MAX_FILE,DAY}=require('../lib/engraving-files.cjs');
const token='a'.repeat(64),other='b'.repeat(64),key='offline-engraving-order-1234';
const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
function fixture(options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'engraving-test-'));let now=Date.now();const s=new EngravingStorage(dir,{minFree:0,free:()=>100*1024**3,now:()=>now,...options});return {s,dir,advance:d=>now+=d,close:()=>{s.close();fs.rmSync(dir,{recursive:true,force:true});}};}
async function upload(s,owner=token,id=randomUUID(),buffer=pdf,name='Логотип.pdf'){return s.receive(s.reserve(owner,id,name,buffer.length,'isolated'),Readable.from([buffer]));}
test('real SQLite: original bytes, owner isolation, three file cap, immutable order binding and private downloads',async()=>{
 const f=fixture();try{const a=await upload(f.s),b=await upload(f.s),c=await upload(f.s);
 assert.equal(f.s.list(token).length,3);assert.equal(f.s.list(other).length,0);
 await assert.rejects(upload(f.s),{code:'too_many_files'});assert.throws(()=>f.s.bind(other,[a.id],key,'https://example.invalid'),{code:'engraving_files_expired'});
 const links=f.s.bind(token,[a.id,b.id,c.id],key,'https://example.invalid');assert.equal(links.length,3);
 assert.throws(()=>f.s.remove(token,a.id),{code:'file_locked'});
 const [id,secret]=links[0].split('#')[1].split('.');
 assert.deepEqual(fs.readFileSync(f.s.download(id,secret).path),pdf);
 assert.throws(()=>f.s.download(id,other),{status:404});
 assert.throws(()=>f.s.bind(token,[id],'another-order-key-1234','https://example.invalid'),{code:'engraving_files_expired'});
 assert.deepEqual(f.s.bind(token,[id],key,'https://example.invalid'),[links[0]]);
 f.s.complete(key,'offline-id','OFFLINE');f.advance(100*DAY);assert.equal(f.s.cleanup(),0);assert.equal(f.s.list(token).length,3);
 }finally{f.close();}
});
test('global quota and free-space limits stop uploads, including reservations from a second process connection',async()=>{
 const f=fixture({maxBytes:pdf.length*2});const second=new EngravingStorage(f.dir,{minFree:0,maxBytes:pdf.length*2,free:()=>1e12});try{
 f.s.reserve(token,randomUUID(),'one.pdf',pdf.length,'a');second.reserve(other,randomUUID(),'two.pdf',pdf.length,'b');
 assert.throws(()=>f.s.reserve(token,randomUUID(),'three.pdf',pdf.length,'a'),{code:'storage_full'});
 }finally{second.close();f.close();}
 const low=fixture({minFree:100,free:()=>99});try{await assert.rejects(upload(low.s),{code:'storage_full'});assert.equal(low.s.stats().length,0);}finally{low.close();}
});
test('invalid/truncated/oversized uploads release space; upload retry with same ID is idempotent',async()=>{
 const f=fixture();try{
 const r=f.s.reserve(token,randomUUID(),'broken.pdf',pdf.length,'a');await assert.rejects(f.s.receive(r,Readable.from([pdf.subarray(2)])),{code:'incomplete_upload'});
 assert.equal(f.s.stats().length,0);const a=await upload(f.s);assert((await upload(f.s,token,a.id)).replayed);assert.equal(f.s.list(token).length,1);
 assert.throws(()=>f.s.reserve(token,randomUUID(),'large.pdf',MAX_FILE+1,'a'),{status:413});
 await assert.rejects(upload(f.s,token,randomUUID(),Buffer.from('<html>bad</html>'),'bad.pdf'),{code:'invalid_file'});
 assert.equal(f.s.list(token).length,1);
 }finally{f.close();}
});
test('cleanup expires only abandoned uploads, keeps unknown CRM outcomes, safely releases pre-order failures',async()=>{
 const f=fixture();try{const a=await upload(f.s),b=await upload(f.s);f.s.bind(token,[a.id],key,'https://example.invalid');
 f.advance(8*DAY);assert.equal(f.s.cleanup(),1);assert.equal(f.s.list(token)[0].id,a.id);assert(!fs.existsSync(path.join(f.dir,'blobs',b.id)));
 f.s.unbind(key);assert.equal(f.s.cleanup(),1);assert.equal(f.s.list(token).length,0);
 }finally{f.close();}
});
test('SVG parser rejects script, remote resources, style, entities and malformed XML; preserves safe vectors',async()=>{
 const wrap=s=>Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'+s+'</svg>');
 await validateFile(wrap('<path d="M0 0 L10 10" stroke="black"/>'),'logo.svg');
 for(const body of ['<script>alert(1)</script>','<g onclick="alert(1)"/>','<use href="https://example.invalid/a.svg"/>','<path style="fill:red"/>','<g>','<foreignObject/>','<path fill="url(https://example.invalid)"/>'])await assert.rejects(validateFile(wrap(body),'logo.svg'));
 await assert.rejects(validateFile(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'),'logo.svg'));
});
test('tampered/missing bytes cannot be bound to an order',async()=>{const f=fixture();try{const a=await upload(f.s);fs.writeFileSync(path.join(f.dir,'blobs',a.id),'bad');assert.throws(()=>f.s.bind(token,[a.id],key,'https://example.invalid'),{code:'engraving_files_unavailable'});assert.equal(f.s.list(token)[0].state,'ready');}finally{f.close();}});
