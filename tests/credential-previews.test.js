const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { File } = require("node:buffer");

const script = fs.readFileSync("assets/js/admin-previews.js", "utf8");
const html = fs.readFileSync("admin/index.html", "utf8");
const css = fs.readFileSync("assets/css/site.css", "utf8");
const verify = fs.readFileSync("verify/index.html", "utf8");
const shell = fs.readFileSync("assets/js/shell.js", "utf8");

const ID = "BPA-FND-2026-WHXRTT";
const PDF = ID + "/20261016T005038-dc64b30b.pdf";
const PNG = ID + "/20261016T005038-dc64b30b.png";
const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);
const validPng = (name=ID+".png", body=pngSignature) => new File([body],name,{type:"image/png"});

function elem() { return {
  files: [], value:"", disabled:false, hidden:true, className:"", textContent:"",
  callbacks:{},
  addEventListener(k,cb){this.callbacks[k]=cb}
}; }

function setup(options={}) {
  const elements={};
  const document={
    getElementById(k){return elements[k]||(elements[k]=elem());}
  };
  const row={id:"record-1",credential_id:ID,holder_name:"Carl Lokko",pdf_path:PDF,preview_path:null};
  const calls=[];
  const authFetch=async (path,req={})=>{
    calls.push({path,req});
    if(path.startsWith("/storage/v1/object/credentials/")){
      if(req.method==="HEAD") return new Response("",{status:options.alreadyUploaded?200:404});
      if(req.method==="POST") return new Response("{}",{status:options.failUpload?500:200});
    }
    if(path.startsWith("/rest/v1/credentials")&&req.method==="PATCH"){
      const json=JSON.parse(req.body);
      if(options.failLink) return new Response("[]",{status:200});
      return new Response(JSON.stringify([{preview_path:json.preview_path}]),{status:200});
    }
    throw new Error("Unexpected call "+path);
  };
  const context={document,authFetch,credState:{rows:[row]},loadCredentials:async()=>{},
    window:{confirm:()=>true},Array,Uint8Array,Promise,JSON,Blob,File,Response};
  vm.runInNewContext(script,context,{filename:"admin-previews.js"});
  return {elements,calls,row};
}
function done(h) {
  return new Promise((resolve,reject)=>{
    const until=Date.now()+1500;
    const check=()=>{
      if(/Previews linked \d+ of \d+/.test(h.elements["preview-upload-result"].textContent))return resolve();
      if(Date.now()>until)return reject(new Error("Preview upload did not finish: "+h.elements["preview-upload-result"].textContent));
      setTimeout(check,10);
    };check();
  });
}

test("existing public PDF and download path are untouched by preview upload UI",()=>{
  assert.ok(html.includes('id="preview-upload-files"'));
  assert.ok(html.indexOf('src="/assets/js/admin.js"') <
    html.indexOf('src="/assets/js/admin-previews.js"'));
  assert.ok(html.includes('id="archive-batch-files"'));
  assert.ok(html.includes('id="issue-form"'));
  assert.ok(verify.includes('data-f="preview-fallback"'));
  assert.ok(css.includes(".cert__img[hidden] { display: none; }"));
  assert.ok(shell.includes("img.addEventListener(\"error\""));
});

test("backfill uploads preview then updates ONLY preview_path",async()=>{
  const h=setup();
  h.elements["preview-upload-files"].files=[validPng()];
  h.elements["preview-upload-btn"].callbacks.click();
  await done(h);
  assert.equal(h.calls.length,3);
  assert.match(h.calls[0].path,/\/20261016T005038-dc64b30b\.png$/);
  assert.equal(h.calls[0].req.method,"HEAD");
  assert.equal(h.calls[1].req.method,"POST");
  assert.equal(h.calls[1].req.headers["x-upsert"],"false");
  assert.equal(h.calls[2].req.method,"PATCH");
  assert.deepEqual(JSON.parse(h.calls[2].req.body),{preview_path:PNG});
  assert.equal(h.row.pdf_path,PDF);
  assert.equal(h.row.preview_path,PNG);
  assert.equal(h.elements["preview-upload-btn"].disabled,false);
});

test("bad PNG signature cannot be uploaded",async()=>{
  const h=setup();
  h.elements["preview-upload-files"].files=[validPng(ID+".png",Buffer.from("FAKE-PNG"))];
  h.elements["preview-upload-btn"].callbacks.click();
  await done(h);
  assert.equal(h.calls.length,0);
  assert.equal(h.row.preview_path,null);
});

test("failed storage upload cannot link preview or alter PDF",async()=>{
  const h=setup({failUpload:true});
  h.elements["preview-upload-files"].files=[validPng()];
  h.elements["preview-upload-btn"].callbacks.click();
  await done(h);
  assert.equal(h.calls.length,2); // HEAD then failed POST
  assert.equal(h.row.pdf_path,PDF);
  assert.equal(h.row.preview_path,null);
});

test("PATCH returning zero rows is not reported as success",async()=>{
  const h=setup({failLink:true});
  h.elements["preview-upload-files"].files=[validPng()];
  h.elements["preview-upload-btn"].callbacks.click();
  await done(h);
  assert.equal(h.row.pdf_path,PDF);
  assert.equal(h.row.preview_path,null);
  assert.match(h.elements["preview-upload-result"].textContent,/Failed/);
});

test("existing immutable preview object can be linked without reuploading",async()=>{
  const h=setup({alreadyUploaded:true});
  h.elements["preview-upload-files"].files=[validPng()];
  h.elements["preview-upload-btn"].callbacks.click();
  await done(h);
  assert.equal(h.calls.length,2); // HEAD then PATCH
  assert.equal(h.row.preview_path,PNG);
  assert.equal(h.row.pdf_path,PDF);
});
