/* CSV formula injection in the admin exports (Codex audit, 9 November 2026).
 * Names, cities, notes and UTM values are typed by the public. A cell starting
 * with = + - @ (or a tab or carriage return) is evaluated as a formula by Excel
 * and Google Sheets even when quoted, so every admin export must make it text.
 * Evaluates the actual `cell` helper from each export, not a copy of it.
 *   node --test tests/admin-csv.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

function cellsIn(file) {
  const src = fs.readFileSync(file, "utf8");
  // Each export defines `var cell = function (v) { ... };` (one line or several).
  const found = [...src.matchAll(/var cell = (function \(v\) \{[\s\S]*?\n?\s*\};)/g)].map((m) => m[1].replace(/;$/, ""));
  assert.ok(found.length > 0, "no cell helper found in " + file);
  return found.map((body) => new Function("return " + body)());
}

const exports_ = [
  ...cellsIn("assets/js/admin-workshops.js").map((fn) => ["admin-workshops.js registrations", fn]),
  ...cellsIn("assets/js/admin.js").map((fn, i) => ["admin.js export " + (i + 1), fn]),
];

test("every admin CSV export is covered", () => {
  // Workshop registrations; cohort enrollments, payment events and credentials.
  assert.equal(exports_.length, 4);
});

const formulas = ['=HYPERLINK("https://evil.example","x")', "+SUM(1,2)", "-2+3", "@cmd", "\t=1+1", "\r=1+1", "=cmd|' /C calc'!A0"];

for (const [name, cell] of exports_) {
  test(name + ": a formula is exported as text", () => {
    for (const value of formulas) {
      const out = cell(value);
      const unquoted = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
      assert.ok(unquoted.startsWith("'"), JSON.stringify(value) + " exported as " + JSON.stringify(out));
      assert.equal(unquoted.slice(1), value, "the value itself is kept");
    }
  });
  test(name + ": ordinary values are unchanged and CSV-escaped as before", () => {
    assert.equal(cell("Ama Mensah"), "Ama Mensah");
    assert.equal(cell(350), "350");
    assert.equal(cell('Say "hi", then go'), '"Say ""hi"", then go"');
    assert.equal(cell("two\nlines"), '"two\nlines"');
    assert.equal(cell(null), "");
  });
}
