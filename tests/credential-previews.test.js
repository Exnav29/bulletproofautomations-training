const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('admin/index.html','utf8'),code=fs.readFileSync('assets/js/admin-previews.js','utf8');
test('preview repair requires no PNG upload and leaves unrelated controls present',()=>{
 assert.doesNotMatch(html,/preview-upload-files|accept=".png/);assert.doesNotMatch(code,/storage\/v1\/object|PATCH|image\/png/);
 for(const id of ['preview-repair-btn','archive-regenerate-btn','issue-form','cred-rows','enq-rows'])assert.ok(html.includes('id="'+id+'"'));
});
test('bulk repair continues after individual failure and reports per-certificate outcomes',async()=>{
 const btn={addEventListener(n,cb){this.click=cb;}},result={};const seen=[];
 const rows=[{credential_id:'one',pdf_path:'one.pdf'},{credential_id:'two',pdf_path:'two.pdf'},{credential_id:'skip',pdf_path:null}];
 const context={document:{getElementById:id=>id==='preview-repair-btn'?btn:result},credState:{rows},loadCredentials:async()=>{},Promise,
 window:{processCredentialArchive:async(r,k,mode)=>{seen.push([r.credential_id,k,mode]);if(r.credential_id==='one')throw Error('conversion');return{result:{already_processed:false}};}}};
 vm.runInNewContext(code,context);btn.click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(seen.length,2);assert.match(result.textContent,/one: Failed/);assert.match(result.textContent,/two: Completed/);assert.equal(btn.disabled,false);
});
