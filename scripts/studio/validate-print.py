"""Validate actual rendered PDFs. Requires PyMuPDF, Pillow and zxing-cpp.
Run after studio-pdf.test.ts, passing the resulting PDF paths.
"""
import sys, json, hashlib
from pathlib import Path
import fitz
from PIL import Image
import zxingcpp

results=[]
for file in map(Path,sys.argv[1:]):
 doc=fitz.open(file);pages=[]
 for index,page in enumerate(doc):
  text=page.get_text();draft='DRAFT' in text;w,h=page.rect.width,page.rect.height
  assert (abs(w-792)<.001 and abs(h-612)<.001) or (abs(w-841.8898)<.001 and abs(h-595.2756)<.001),'Unexpected paper dimensions'
  for kind,box,*_ in page.get_bboxlog():
   if kind in ('fill-text','fill-image'):
    x0,y0,x1,y1=box
    assert min(x0,y0)>=17.8 and x1<=w-17.8 and y1<=h-17.8,'Content outside printer-safe margins'
  for block in page.get_text('dict')['blocks']:
   for line in block.get('lines',[]):
    for span in line['spans']:
     if 'Serif' in span['font'] and h/2-65<span['bbox'][1]<h/2:
      assert span['bbox'][3]<h/2-4,'Graduate name touches decorative divider'
  pix=page.get_pixmap(matrix=fitz.Matrix(2,2));codes=zxingcpp.read_barcodes(Image.frombytes('RGB',[pix.width,pix.height],pix.samples))
  if draft:assert not codes,'Draft must not contain a verification QR code'
  else:assert len(codes)==1 and codes[0].text.startswith('https://training.bulletproofautomations.com/verify/BPA-'),'Issued PDF requires one readable verification QR'
  pages.append({'page':index+1,'width_points':w,'height_points':h,'draft':draft,'qr':[r.text for r in codes]})
 results.append({'file':file.name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'pages':pages})
print(json.dumps(results,indent=2))
