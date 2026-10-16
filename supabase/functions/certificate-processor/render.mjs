// Server-side only. PDFium renders the actual page; no canvas or HTML remake.
import { PDFiumLibrary } from 'npm:@hyzyla/pdfium@3.0.0';
import { encode, decode } from 'npm:fast-png@8.0.0';
export const MAX_PDF = 15 * 1024 * 1024;
const WASM = 'https://cdn.jsdelivr.net/npm/@hyzyla/pdfium@3.0.0/dist/pdfium.wasm';
const WASM_SHA = 'beeaf5bbff216d555fecec7cd486072838c4632a2272d31b52ef1fd05008fe7c';
let library;
export async function sha(data) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), x => x.toString(16).padStart(2, '0')).join('');
}
export function validatePdf(data) {
  if (!data.length || data.length > MAX_PDF || new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-' ||
      !new TextDecoder().decode(data.slice(-2048)).includes('%%EOF')) throw Error('Invalid PDF content or size (maximum 15 MiB).');
}
export function validatePng(data, width, height) {
  if (!data.length || data.length > 5 * 1024 * 1024 ||
      ![137,80,78,71,13,10,26,10].every((v,i) => data[i] === v)) throw Error('Invalid PNG content or size.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const w = view.getUint32(16), h = view.getUint32(20);
  if (w !== width || h !== height || w * h > 12_000_000) throw Error('Preview dimensions do not match the PDF.');
  const image = decode(data, { checkCrc: true });
  if (image.width !== width || image.height !== height || !image.data.length) throw Error('Preview failed full PNG decode.');
}
export async function render(pdf) {
  validatePdf(pdf);
  if (!library) library = (async () => {
    const response = await fetch(WASM, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Error('Renderer binary unavailable.');
    const binary = new Uint8Array(await response.arrayBuffer());
    if (binary.length > 6 * 1024 * 1024 || await sha(binary) !== WASM_SHA) throw Error('Renderer integrity check failed.');
    return PDFiumLibrary.init({ wasmBinary: binary });
  })().catch(e => { library = undefined; throw e; });
  const lib = await library;
  const doc = await lib.loadDocument(pdf);
  try {
    if (!doc.getPageCount()) throw Error('PDF has no readable page.');
    const page = doc.getPage(0);
    const size = page.getOriginalSize();
    const width = Math.floor(size.originalWidth * 2), height = Math.floor(size.originalHeight * 2);
    if (Math.min(width, height) < 72 || Math.max(width, height) > 6000 || width * height > 12_000_000) throw Error('PDF page exceeds rendering limits.');
    const image = await page.render({ scale: 2, renderFormFields: true,
      render: async ({data, width, height}) => encode({ data, width, height, channels: 4 }) });
    validatePng(image.data, image.width, image.height);
    return { png: image.data, width: image.width, height: image.height, pdfSha: await sha(pdf), pngSha: await sha(image.data) };
  } finally { doc.destroy(); }
}
