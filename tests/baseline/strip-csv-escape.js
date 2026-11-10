/* Used by compare-site.sh. Prints assets/js/admin.js with exactly the CSV formula
 * escaping removed (Codex audit; docs/workshops-shared-changes.md, change 9), so the
 * rest of the cohort admin must still be byte-identical to main. */
const fs = require("fs");
let t = fs.readFileSync(process.argv[2], "utf8");
const added = new Set([
  "    // A value starting with = + - @ or a tab/CR is a formula to Excel and Sheets;",
  "    // prefixing ' makes it text (Codex audit: CSV formula injection).",
  "    if (/^[=+\\-@\\t\\r]/.test(s)) s = \"'\" + s;"
]);
t = t.split(/\r?\n/).filter((l) => !added.has(l)).join("\n");
t = t.split('return /[",\\r\\n]/.test(s) ?').join('return /[",\\n]/.test(s) ?');
process.stdout.write(t);
