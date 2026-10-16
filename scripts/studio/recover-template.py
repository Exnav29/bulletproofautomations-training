"""Recover approved artwork; original bytes remain outside the public build/repo.
Usage: python recover-template.py ORIGINAL_PDFS OUTPUT_DIR
Requires PyMuPDF. Audits all supplied certificates before accepting signature.
"""
import sys, pathlib, hashlib, json
import fitz
source,out=map(pathlib.Path,sys.argv[1:]);out.mkdir(parents=True,exist_ok=True)
files=sorted(source.glob('*.pdf')); hashes=[]
for file in files:
 d=fitz.open(file); image=d[0].get_images()[0]; pix=fitz.Pixmap(d,image[0]);mask=fitz.Pixmap(d,image[1]); rgba=fitz.Pixmap(pix,mask).tobytes('png');hashes.append(hashlib.sha256(rgba).hexdigest())
assert len(files)==9 and len(set(hashes))==1,'Nine identical approved signatures required'
d=fitz.open(files[0]);p=d[0]
for font in p.get_fonts(full=True):
 if font[3]=='DejaVu Serif Bold':(out/'serif.ttf').write_bytes(d.extract_font(font[0])[3])
 if font[3]=='DejaVu Sans Book':(out/'body.ttf').write_bytes(d.extract_font(font[0])[3])
image=p.get_images()[0];signature=fitz.Pixmap(fitz.Pixmap(d,image[0]),fitz.Pixmap(d,image[1])).tobytes('png');(out/'signature.png').write_bytes(signature)
# Redaction removes original personal data, course-specific text, signature and QR.
regions=[(630,57,745,81),(210,170,700,215),(180,258,725,302),(200,317,710,389),
 (155,451,335,471),(155,469,352,506),(155,530,350,546),(282,557,710,574),(380,485,740,550),(650,465,738,555)]
for r in regions:p.add_redact_annot(fitz.Rect(r),fill=(245/255,248/255,247/255))
p.apply_redactions(images=2,graphics=0)
# Strip metadata and unused original page streams/images so signature is absent.
d.set_metadata({});d.save(out/'template-001-v1.pdf',garbage=4,deflate=True,clean=True,no_new_id=True)
for x,_,_,name,*_ in p.get_fonts(full=True):
 if name=='DejaVu Serif Bold':(out/'serif.ttf').write_bytes(d.extract_font(x)[3])
 if name=='DejaVu Sans Book':(out/'body.ttf').write_bytes(d.extract_font(x)[3])
manifest={'template':'001','version':1,'source_pdfs':[f.name for f in files], 'signature_sha256':hashes[0], 'signature_pixels':[358,78], 'source_rect':[155.22219848632812,463.223876953125,348.07403564453125,505.24188232421875], 'source_generator':'Not present in recovered packages; exact embedded artwork extracted from all nine approved issued PDFs.', 'assets':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in out.iterdir() if f.is_file()}}
(out/'provenance.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps(manifest))
