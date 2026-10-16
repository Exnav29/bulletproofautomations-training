const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path='../supabase/functions/certificate-processor/core.mjs';
const ID='BPA-FND-2026-WHXRTT', PDF=ID+'/20261016T005038-dc64b30b.pdf';
const make=()=>({credential_id:ID,mode:'repair',master_path:PDF,expected_pdf_path:PDF,expected_updated_at:'2026-10-16T00:00:00Z'});
const hash=async b=>Buffer.from(b).toString('hex');
const png=new Uint8Array([1,2,3]);const pdf=new Uint8Array([4,5,6]);
const renderer=async()=>({png,width:1584,height:1224,pdfSha:'pdf-hash',pngSha:'png-hash'});
function api(options={}){
 const calls=[];return {calls,
 async stage(j,s){calls.push(['stage',s]);},
 async get(bucket,key){calls.push(['get',bucket,key]);return options.mismatch&&bucket==='credentials'?png:pdf;},
 async ensure(bucket,key,data,mime){calls.push(['ensure',bucket,key,mime]);if(options.uploadFailure)throw Error('storage failed');},
 async complete(j,r){calls.push(['complete',r]);if(options.stale)throw Error('Credential changed');return r;}};
}
test('valid repair keeps the current version',async()=>{const {validateJob}=await import(path);assert.equal(validateJob(make()).master_path,PDF);});
test('malformed IDs, paths, modes, versions and cross-credential paths rejected',async()=>{
 const {validateJob}=await import(path);
 for(const change of [{credential_id:'../../secret'},{master_path:'https://attacker/a.pdf'},{master_path:'../etc/passwd'},{mode:'delete'},
 {expected_updated_at:null},{master_path:PDF.replace('WHXRTT','D7S1ZC')},{expected_pdf_path:PDF.replace('WHXRTT','D7S1ZC')}])assert.throws(()=>validateJob({...make(),...change}));
});
test('repair retrieves both existing PDFs, renders and verifies before linking',async()=>{
 const {processJob}=await import(path);const a=api();const result=await processJob(a,make(),renderer,hash,()=>{});
 assert.equal(result.pdf_path,PDF);assert.equal(result.preview_path,PDF.replace('.pdf','.png'));
 assert.deepEqual(a.calls.filter(x=>x[0]==='get').map(x=>x[1]),['credential-masters','credentials']);
 assert.deepEqual(a.calls.filter(x=>x[0]==='ensure').map(x=>x[3]),['application/pdf','image/png']);
 assert.equal(a.calls.at(-1)[0],'complete');
});
test('new upload and restoration use the retained private master',async()=>{
 const {processJob}=await import(path);
 for(const mode of ['publish','restore']){const a=api();await processJob(a,{...make(),mode},renderer,hash,()=>{});
 assert.equal(a.calls.filter(x=>x[0]==='get').length,1);assert.equal(a.calls.at(-1)[1].pdf_path,PDF);}
});
test('renderer failure retains old links and permits a retry',async()=>{
 const {processJob}=await import(path);const a=api();await assert.rejects(processJob(a,make(),async()=>{throw Error('conversion failed');},hash,()=>{}));
 assert.equal(a.calls.some(x=>x[0]==='ensure'||x[0]==='complete'),false);
 await processJob(a,make(),renderer,hash,()=>{});assert.equal(a.calls.at(-1)[0],'complete');
});
test('failed PNG validation cannot publish either object or link paths',async()=>{
 const {processJob}=await import(path);const a=api();await assert.rejects(processJob(a,make(),renderer,hash,()=>{throw Error('bad PNG');}));
 assert.equal(a.calls.some(x=>x[0]==='ensure'||x[0]==='complete'),false);
});
test('Storage failure and stale completion never report success',async()=>{
 const {processJob}=await import(path);for(const o of [{uploadFailure:true},{stale:true}])await assert.rejects(processJob(api(o),make(),renderer,hash,()=>{}));
});
test('mismatched public PDF and private master require attention',async()=>{
 const {processJob}=await import(path);const a=api({mismatch:true});await assert.rejects(processJob(a,make(),renderer,hash,()=>{}),/differs/);
 assert.equal(a.calls.some(x=>x[0]==='complete'),false);
});
test('repeat processing uses exactly the same immutable object keys',async()=>{
 const {processJob}=await import(path);const a=api();await processJob(a,make(),renderer,hash,()=>{});await processJob(a,make(),renderer,hash,()=>{});
 const keys=a.calls.filter(x=>x[0]==='ensure').map(x=>x[2]);assert.deepEqual(keys.slice(0,2),keys.slice(2));
});
test('queue functions are service-role only, transactionally guarded and never send mail',()=>{
 const sql=fs.readFileSync('supabase/certificate-processing.sql','utf8');
 assert.match(sql,/from public,anon,authenticated/);assert.match(sql,/to service_role/);
 assert.match(sql,/certificate_one_active/);assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(sql,/c.updated_at<>j.expected_updated_at/);assert.match(sql,/j.mode='repair'[\s\S]*set preview_path=preview/);
 assert.doesNotMatch(sql,/update public.credentials set (?:holder|issued|status|publish|allow)/);
 assert.doesNotMatch(sql,/delete from|update storage.objects|send.email|mailboxes/i);
});
test('public verifier and URL structures remain intact with PDF fallback',()=>{
 const s=fs.readFileSync('assets/js/shell.js','utf8');
 assert.match(s,/\/verify\//);assert.match(s,/preview-fallback/);assert.match(s,/pdf.setAttribute\("href", row.pdfUrl\)/);
 const api=fs.readFileSync('functions/api/verify.js','utf8');assert.match(api,/row.preview_path \? base \+ row.preview_path/);
});
