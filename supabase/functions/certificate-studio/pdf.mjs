// Server-only PDF composition. No browser PDF library or signature exposure.
import { PDFDocument, rgb, degrees } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import QRCode from "npm:qrcode@1.5.4";
import { certificateCourseLabel } from "./domain.mjs";
export const SIGNATURE_SHA =
  "f4c41e33e2c40bd02d0eb7610616d962d710cdf333b492dccedbbf3f118a4677";
export const TEMPLATE_SHA =
  "16a2c4cc0e70bd87a869cffbbfe7c17de8479e2ef8c43dcd3ced5200f42f8eac";
export async function hash(bytes) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
const navy = rgb(0.059, 0.161, 0.212),
  teal = rgb(0.08, 0.41, 0.43),
  muted = rgb(0.38, 0.45, 0.48);
const date = (s) =>
  new Date(s + "T12:00:00Z")
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    })
    .toUpperCase();
export async function generate(
  data,
  assets,
  { draft = true, format = "letter" } = {},
) {
  if (!["letter", "a4"].includes(format)) throw Error("Select Letter or A4.");
  if ((await hash(assets.template)) !== TEMPLATE_SHA)
    throw Error("Template integrity check failed.");
  if (!draft && (await hash(assets.signature)) !== SIGNATURE_SHA)
    throw Error("Approved signature integrity check failed.");
  const doc = await PDFDocument.load(assets.template);
  doc.registerFontkit(fontkit);
  const body = await doc.embedFont(assets.body, { subset: true }),
    serif = await doc.embedFont(assets.serif, { subset: true });
  const page = doc.getPages()[0];
  function text(
    value,
    x,
    top,
    width,
    size,
    font = body,
    color = navy,
    center = false,
  ) {
    value = String(value || "");
    if (!value) return;
    if (value.length > 800)
      throw Error("Certificate text exceeds layout limit.");
    while (font.widthOfTextAtSize(value, size) > width && size > 6)
      size -= 0.25;
    if (font.widthOfTextAtSize(value, size) > width)
      throw Error("Text does not fit. Shorten the certificate wording.");
    page.drawText(value, {
      x: x + (center ? (width - font.widthOfTextAtSize(value, size)) / 2 : 0),
      y: 612 - top - size,
      font,
      size,
      color,
    });
  }
  function lines(
    value,
    x,
    top,
    width,
    size,
    max = 2,
    font = body,
    color = navy,
  ) {
    const words = String(value || "").split(/\s+/);
    let rows = [""];
    for (const w of words) {
      const i = rows.length - 1;
      const next = (rows[i] + " " + w).trim();
      if (font.widthOfTextAtSize(next, size) > width && rows[i]) rows.push(w);
      else rows[i] = next;
    }
    if (rows.length > max) {
      if (size <= 8) throw Error("Text exceeds available certificate space.");
      return lines(value, x, top, width, size - 0.5, max, font, color);
    }
    rows.forEach((v, i) =>
      text(v, x, top + i * (size + 3), width, size, font, color, true),
    );
  }
  text(
    data.course_code + " / " + String(data.issue_date).slice(0, 4),
    600,
    64,
    138,
    8,
    body,
    muted,
  );
  text(
    data.certificate_title || "Certificate of Completion",
    185,
    174,
    536,
    31,
    serif,
    navy,
    true,
  );
  if (serif.widthOfTextAtSize(data.full_name, 27) <= 544)
    text(data.full_name, 180, 265, 544, 27, serif, teal, true);
  else lines(data.full_name, 180, 250, 544, 20, 2, serif, teal);
  lines(data.statement, 190, 320, 520, 11, 2);
  lines(certificateCourseLabel(data.course_name, data.level), 190, 349, 520, 15, 2, body);
  text(date(data.start_date) + " – " + date(data.end_date), 160, 455, 200, 10);
  text("Founder, Bulletproof Automations", 160, 532, 200, 8, body, muted);
  text("ISSUE DATE", 385, 486, 110, 8, body, muted);
  text(date(data.issue_date), 385, 499, 117, 10, serif);
  text("CERTIFICATE ID", 385, 522, 115, 8, body, muted);
  text(
    draft ? "DRAFT — NOT ISSUED" : data.credential_id,
    385,
    538,
    117,
    7,
    body,
  );
  text("VERIFY CERTIFICATE", 516, 476, 130, 8, body, muted);
  text("training.bulletproofautomations.com", 516, 492, 133, 6.8, body, teal);
  text(
    draft ? "Not publicly verifiable" : "/verify/" + data.credential_id,
    516,
    505,
    133,
    6.8,
    body,
  );
  text(
    "An independent Bulletproof Automations training certificate; not a vendor certification.",
    250,
    561,
    460,
    7,
    body,
    muted,
    true,
  );
  if (draft) {
    page.drawText("DRAFT", {
      x: 275,
      y: 220,
      size: 72,
      font: serif,
      color: rgb(0.6, 0.22, 0.15),
      opacity: 0.18,
      rotate: degrees(22),
    });
  } else {
    const sig = await doc.embedPng(assets.signature);
    page.drawImage(sig, {
      x: 155.2222,
      y: 612 - 505.2419,
      width: 192.8518,
      height: 42.018,
    });
    const code = QRCode.create(
      "https://training.bulletproofautomations.com/verify/" +
        data.credential_id,
      { errorCorrectionLevel: "M" },
    );
    const n = code.modules.size,
      unit = 68 / (n + 8),
      left = 660,
      top = 474;
    page.drawRectangle({
      x: left,
      y: 612 - top - 76,
      width: 76,
      height: 76,
      color: rgb(1, 1, 1),
    });
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (code.modules.get(r, c))
          page.drawRectangle({
            x: left + 4 + (c + 4) * unit,
            y: 612 - top - 4 - (r + 5) * unit,
            width: unit + 0.005,
            height: unit + 0.005,
            color: rgb(0, 0, 0),
          });
  }
  // Uniform placement of the completed vector page; explicit layout per format.
  // Letter and A4 each get a true page size with >=18pt safe margins.
  const out = await PDFDocument.create(),
    w = format === "a4" ? 841.8898 : 792,
    h = format === "a4" ? 595.2756 : 612;
  const [embedded] = await out.embedPdf(await doc.save(), [0]);
  const s = Math.min((w - 36) / 792, (h - 36) / 612);
  out
    .addPage([w, h])
    .drawPage(embedded, {
      x: (w - 792 * s) / 2,
      y: (h - 612 * s) / 2,
      width: 792 * s,
      height: 612 * s,
    });
  out.setTitle(
    (draft ? "DRAFT — " : "") + data.certificate_title + " — " + data.full_name,
  );
  out.setAuthor("Bulletproof Automations");
  out.setCreationDate(new Date(data.issue_date + "T12:00:00Z"));
  out.setModificationDate(new Date(data.issue_date + "T12:00:00Z"));
  return out.save();
}
export async function combine(files) {
  const out = await PDFDocument.create();
  for (const bytes of files) {
    const d = await PDFDocument.load(bytes);
    if (d.getPageCount() !== 1)
      throw Error("Each certificate must be one page.");
    const [p] = await out.copyPages(d, [0]);
    out.addPage(p);
  }
  return out.save();
}
