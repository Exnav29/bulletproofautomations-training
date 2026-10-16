import { render, validatePdf, validatePng } from '../supabase/functions/certificate-processor/render.mjs';
function assert(value: unknown, message='Assertion failed') { if(!value) throw Error(message); }
function fixture(width=792,height=612,rotate=0) {
  const text='BT /F1 24 Tf 40 80 Td (Certificate test) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotate} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n';
  for(const off of offsets.slice(1))pdf+=String(off).padStart(10,'0')+' 00000 n \n';
  pdf+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
Deno.test('actual WASM landscape PDF rendering and validated PNG are 1584×1224',async()=>{
 const result=await render(fixture());assert(result.width===1584&&result.height===1224);
 validatePng(result.png,1584,1224);assert(result.png.length>1000);assert(result.pdfSha.length===64);
});
Deno.test('actual rotated portrait renders landscape without cropping',async()=>{
 const result=await render(fixture(612,792,90));assert(result.width===1584&&result.height===1224);
});
Deno.test('actual portrait retains its orientation',async()=>{
 const result=await render(fixture(612,792));assert(result.width===1224&&result.height===1584);
});
Deno.test('corrupt, fake, empty and oversized PDFs are rejected',async()=>{
 for(const bytes of [new Uint8Array(),new TextEncoder().encode('fake'),new Uint8Array(15*1024*1024+1),new TextEncoder().encode('%PDF-1.4\ncorrupt\n%%EOF')]) {
  let rejected=false;try{validatePdf(bytes);await render(bytes);}catch{rejected=true;}assert(rejected);
 }
});
Deno.test('excessive page dimensions and corrupt PNGs are rejected',async()=>{
 let rejected=false;try{await render(fixture(10000,10000));}catch{rejected=true;}assert(rejected);
 rejected=false;try{validatePng(new Uint8Array([137,80,78]),1584,1224);}catch{rejected=true;}assert(rejected);
});
