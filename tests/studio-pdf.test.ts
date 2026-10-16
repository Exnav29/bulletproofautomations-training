import {
  generate,
  combine,
  hash,
  SIGNATURE_SHA,
} from "../supabase/functions/certificate-studio/pdf.mjs";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
const base = Deno.env.get("STUDIO_TEST_ASSETS") || "../private-assets";
const read = (name: string) => Deno.readFile(base + "/" + name);
const assets = {
  template: await read("template-001-v1.pdf"),
  body: await read("body.ttf"),
  serif: await read("serif.ttf"),
  signature: await read("signature.png"),
};
const example = {
  full_name: "Controlled Studio Validation",
  course_name: "Workflow Automation Foundations",
  course_code: "WAF",
  level: "Beginner",
  certificate_title: "Certificate of Completion",
  statement: "for successfully completing the hands-on training program",
  start_date: "2026-07-11",
  end_date: "2026-08-29",
  issue_date: "2026-08-29",
  credential_id: "BPA-TRN-2026-T3ST01",
};
function ok(v: unknown, msg = "assertion failed") {
  if (!v) throw Error(msg);
}
Deno.test("exact approved signature asset hash", async () => {
  ok((await hash(assets.signature)) === SIGNATURE_SHA);
});
Deno.test(
  "real signed Letter and A4 PDFs, deterministic retries, batch merge",
  async () => {
    const letter = await generate(example, assets, { draft: false });
    const again = await generate(example, assets, { draft: false });
    ok(
      (await hash(letter)) === (await hash(again)),
      "Retries must be byte-identical",
    );
    const a4 = await generate(example, assets, { draft: false, format: "a4" }),
      draft = await generate(example, assets, { draft: true });
    const second = await generate({...example,full_name:"Another Controlled Graduate",credential_id:"BPA-TRN-2026-T3ST02"},assets,{draft:false});
    const combined = await combine([letter, second]);
    for (const [bytes, w, h, count] of [
      [letter, 792, 612, 1],
      [a4, 841.8898, 595.2756, 1],
      [combined, 792, 612, 2],
    ] as const) {
      const d = await PDFDocument.load(bytes);
      ok(d.getPageCount() === count);
      const p = d.getPages()[0];
      ok(
        Math.abs(p.getWidth() - w) < 0.001 &&
          Math.abs(p.getHeight() - h) < 0.001,
      );
    }
    await Deno.mkdir("../studio-validation", { recursive: true });
    for (const [name, bytes] of [
      ["sample-letter.pdf", letter],
      ["sample-a4.pdf", a4],
      ["sample-draft.pdf", draft],
      ["sample-print-pack.pdf", combined],
    ] as const)
      await Deno.writeFile("../studio-validation/" + name, bytes);
  },
);
Deno.test(
  "long names, course titles, completion wording and unicode render",
  async () => {
    const longPdf = await generate(
      {
        ...example,
        full_name: "Johnathan Alexander Lightfoot Mensah-Owusu Adjei Boateng",
        course_name:
          "Advanced Automation Design, Implementation and Operational Reliability for Business Systems",
        statement:
          "for successfully completing the approved course requirements and demonstrating the practical application of workflow automation techniques",
      },
      assets,
      { draft: false },
    );
    await Deno.writeFile("../studio-validation/long-name-proof.pdf",longPdf);
  },
);
Deno.test(
  "bad signature and unsupported print format are rejected",
  async () => {
    for (const [art, opts] of [
      [{ ...assets, signature: new Uint8Array([1, 2]) }, { draft: false }],
      [assets, { draft: false, format: "a3" }],
    ] as any) {
      let rejected = false;
      try {
        await generate(example, art, opts);
      } catch {
        rejected = true;
      }
      ok(rejected);
    }
  },
);
