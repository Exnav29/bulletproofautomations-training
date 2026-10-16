import { render, sha, validatePng, MAX_PDF } from './render.mjs';
import { validateJob, processJob } from './core.mjs';
const ADMIN = 'johnathan@bulletproofautomations.com';
const PROJECT = 'https://ikkldbhgjleelviwttir.supabase.co';
const URL = Deno.env.get('SUPABASE_URL') || Deno.env.get('PROJECT_URL');
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY');
const origin = 'https://training.bulletproofautomations.com';
const cors = {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,apikey,content-type',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Vary': 'Origin'};
function response(body: unknown, status=200) {
  return new Response(JSON.stringify(body), {status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
}
async function rpc(name: string, body: unknown) {
  const res = await fetch(PROJECT + '/rest/v1/rpc/' + name, {method:'POST',
    headers:{apikey:KEY!,Authorization:'Bearer '+KEY,'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data = await res.json();
  if (!res.ok) throw Error(data.message || 'Database processing request failed.');
  return data;
}
async function admin(req: Request) {
  const auth=req.headers.get('Authorization')||'';
  if (!auth.startsWith('Bearer ')) return false;
  const res=await fetch(PROJECT+'/auth/v1/user',{headers:{apikey:KEY!,Authorization:auth},signal:AbortSignal.timeout(10000)});
  if (!res.ok) return false;
  const user=await res.json();
  return !!user.id && String(user.email||'').toLowerCase()===ADMIN;
}
async function jsonBody(req: Request) {
  const raw=await req.text();
  if(raw.length>4096) throw Error('Request too large.');
  return JSON.parse(raw);
}
const api = {
  async get(bucket: string,key: string,publicRead=false) {
    const res=await fetch(PROJECT+'/storage/v1/object/'+(publicRead?'public/':'')+bucket+'/'+key, {
      headers:publicRead?{}:{apikey:KEY!,Authorization:'Bearer '+KEY},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!res.ok) throw Error('Cannot retrieve archived '+(key.endsWith('.pdf')?'PDF':'preview')+' ('+res.status+').');
    if(Number(res.headers.get('Content-Length'))>MAX_PDF) throw Error('Archive object exceeds size limit.');
    const reader=res.body!.getReader();let length=0;const chunks=[];
    for(;;){const r=await reader.read();if(r.done)break;length+=r.value.length;
      if(length>MAX_PDF){await reader.cancel();throw Error('Archive object exceeds size limit.');}chunks.push(r.value);}
    const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
  },
  async ensure(bucket: string,key: string,bytes: Uint8Array,mime: string) {
    // POST is insert-only. On a retry, only a verified byte-identical existing
    // object is accepted. No UPDATE/DELETE of PDFs, PNGs or private masters.
    const res=await fetch(PROJECT+'/storage/v1/object/'+bucket+'/'+key,{method:'POST',
      headers:{apikey:KEY!,Authorization:'Bearer '+KEY,'Content-Type':mime,'x-upsert':'false','Cache-Control':'max-age=31536000, immutable'},
      body:new Uint8Array(bytes).buffer,signal:AbortSignal.timeout(20000)});
    if(!res.ok && ![400,409].includes(res.status)) throw Error('Archive upload failed ('+res.status+').');
    const stored=await api.get(bucket,key,true);
    if(await sha(stored)!==await sha(bytes)) throw Error('Existing immutable object differs; requires attention.');
  },
  async stage(job: any, stage: string) { await rpc('certificate_job_stage',{p_id:job.id,p_lease:job.lease,p_stage:stage}); },
  async complete(job: any, result: any) { return rpc('certificate_job_complete',{p_id:job.id,p_lease:job.lease,p_result:result}); }
};
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response(null,{headers:cors});
  if(URL?.replace(/\/$/,'')!==PROJECT||!KEY)return response({error:'Processor not configured.'},503);
  const path=new globalThis.URL(req.url).pathname.split('/').pop();
  try {
    if(path==='run' && req.method==='POST') {
      const body=await jsonBody(req);
      // This endpoint accepts only an unguessable database-generated job
      // capability. It cannot enqueue jobs, choose URLs, or alter credentials.
      if(!/^[0-9a-f-]{36}$/.test(body.id)||!/^[0-9a-f]{64}$/.test(body.token))return response({error:'Not authorized.'},403);
      const job=await rpc('certificate_job_claim',{p_id:body.id,p_token:body.token});
      if(!job)return response({state:'busy-or-finished'},202);
      try { const result=await processJob(api,job,render,sha,validatePng);return response(result); }
      catch(e){await rpc('certificate_job_fail',{p_id:job.id,p_lease:job.lease,p_error:String((e as Error).message).slice(0,300)});return response({state:'failed'},422);}
    }
    if(!(await admin(req)))return response({error:'Not authorized.'},403);
    if(path==='health' && req.method==='GET')return response({ok:true,renderer:'PDFium WASM 3.0.0',queue:'Postgres',concurrency:1});
    if(path==='jobs' && req.method==='POST') {
      const body=validateJob(await jsonBody(req));
      return response(await rpc('certificate_job_start',{p_request:body}),202);
    }
    if(path==='jobs' && req.method==='GET') {
      const url=new globalThis.URL(req.url),id=url.searchParams.get('id'),credential=url.searchParams.get('credential');
      if(id&&!/^[0-9a-f-]{36}$/.test(id))return response({error:'Invalid job ID.'},400);
      if(credential&&!/^BPA-(?:FND|BCAB)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/.test(credential))return response({error:'Invalid credential ID.'},400);
      return response(await rpc('certificate_job_status',{p_id:id||null,p_credential:credential||null}));
    }
    if(path==='retry' && req.method==='POST') {
      const body=await jsonBody(req);
      if(!/^[0-9a-f-]{36}$/.test(body.id))return response({error:'Invalid job ID.'},400);
      return response(await rpc('certificate_job_retry',{p_id:body.id}),202);
    }
    return response({error:'Not found.'},404);
  }catch(e){return response({error:String((e as Error).message).slice(0,300)},400);}
});
