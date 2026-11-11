/* Renders workshop pages from database-shaped rows into dist/, exactly as
 * functions/workshops/[[path]].js serves them, so CI can validate real HTML.
 *   npm run build && node tests/render-workshop-pages.mjs [real|samples|all]
 * Writes dist/workshops/index.html, dist/workshops/<slug>/index.html and
 * dist/workshops/<slug>/register/index.html.
 * Run after the build: it reads the shell the build wrote. */
import fs from "node:fs";
import path from "node:path";
import { catalog, route, fill, paths } from "../functions/api/_workshop_pages.js";

const which = process.argv[2] || "real";
const data = JSON.parse(fs.readFileSync(new URL("./fixtures/workshop-rows.json", import.meta.url), "utf8"));
const rows = which === "samples" ? data.samples : which === "all" ? data.real.concat(data.samples) : data.real;
const now = Date.parse(process.env.RENDER_NOW || "2026-11-11T00:00:00Z");
const cat = catalog(rows, which === "samples" ? [] : data.series, now);
const shell = fs.readFileSync("dist/workshops/_shell.html", "utf8");
const written = [];
// The form pages are not in the sitemap (noindex) but are served for every workshop with a page.
const formPages = cat.live.map((s) => "/workshops/" + s.slug + "/register");
for (const p of paths(cat).concat(["/workshops/registered"], formPages)) {
  const page = route(p, cat);
  if (!page) throw new Error("no page for " + p);
  const file = path.join("dist", p, "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fill(shell, page));
  written.push(p);
}
console.log("rendered " + written.length + " workshop pages: " + written.join(", "));
