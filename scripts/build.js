const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const partialsDir = path.join(root, "partials");

// The deployed bundle is an allowlist. Nothing not listed here ships.
// This keeps .git, .github, supabase/, docs/, partials/ and test plans out of production.
// Any new public route MUST be added here or it will 404 in production with no build error.
const publicPaths = [
  // Shared
  "index.html",
  // Cloudflare Pages serves this with a real 404 status for any unmatched
  // path. It must sit at the ROOT of dist/ to be picked up.
  "404.html",
  "assets",
  "robots.txt",
  "sitemap.xml",
  "_redirects",
  "_headers",

  // Rebuild routes - Tier 1
  "certified-automation-builder",
  "standard",
  "thank-you",

  // Rebuild routes - Tier 2
  "foundations",
  "pathway",
  "about",

  // Rebuild routes - Tier 3
  "verify",
  "builder-pool",
  // workshops: dropped 10 August 2026. Price by Value was its only occupant
  // and it is retired, so the route has nothing to hold.
  "privacy",
  "refund-policy",

  // Carried, outside the rebuild's scope
  "admin",
  "nfc",

  // Legacy routes were retired on 11 August 2026, once /foundations and
  // /pathway existed to receive their traffic. All three now 301 from
  // _redirects. assets/js/main.js and assets/css/style.css went with them.
];

/* --------------------------------------------------------------------------
   Includes

   Pages declare shared markup with:

     <!-- include: header.html -->
     <!-- include: pathway-rail.html stage="2" -->
     <!-- include: head.html title="..." description="..." canonical="..." -->

   Partials live in partials/, deliberately absent from publicPaths so it never
   ships. Includes are resolved into dist/ only, so the source tree stays a set
   of plain files.
   -------------------------------------------------------------------------- */

const INCLUDE = /<!--\s*include:\s*([A-Za-z0-9._-]+)((?:\s+[a-zA-Z0-9_]+="[^"]*")*)\s*-->/g;
const ATTR = /([a-zA-Z0-9_]+)="([^"]*)"/g;

const partialCache = new Map();

function readPartial(name) {
  if (!partialCache.has(name)) {
    const file = path.join(partialsDir, name);
    if (!fs.existsSync(file)) {
      throw new Error("Include not found: partials/" + name);
    }
    partialCache.set(name, fs.readFileSync(file, "utf8"));
  }
  return partialCache.get(name);
}

// Maps the authoring-friendly params (stage, nav) onto the placeholders the
// partials use, so page authors never hand-write per-item state.
function expandParams(params) {
  const out = Object.assign({}, params);

  if (params.stage) {
    out["s" + params.stage] = "current";
    out["c" + params.stage] = "step";
  }
  ["1", "2"].forEach(function (n) {
    if (!out["s" + n]) out["s" + n] = "available";
  });

  if (params.nav) {
    out["n_" + params.nav] = "page";
  }

  return out;
}

function resolveIncludes(html, depth) {
  if (depth > 4) throw new Error("Include nesting too deep");

  return html.replace(INCLUDE, function (_match, name, attrString) {
    const params = {};
    let attr;
    while ((attr = ATTR.exec(attrString)) !== null) {
      params[attr[1]] = attr[2];
    }
    ATTR.lastIndex = 0;

    const values = expandParams(params);
    const body = readPartial(name).replace(/\{\{(\w+)\}\}/g, function (_m, key) {
      return values[key] !== undefined ? values[key] : "";
    });

    return resolveIncludes(body, depth + 1);
  });
}

function processHtml(file) {
  const source = fs.readFileSync(file, "utf8");
  INCLUDE.lastIndex = 0;
  if (!INCLUDE.test(source)) return false;
  INCLUDE.lastIndex = 0;

  let html = resolveIncludes(source, 0);

  // An unset aria-current would serialise as aria-current="". Drop it rather
  // than emit an empty ARIA attribute.
  html = html.replace(/\s+aria-current=""/g, "");

  fs.writeFileSync(file, html);
  return true;
}

function walkHtml(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, found);
    else if (entry.name.endsWith(".html")) found.push(full);
  }
  return found;
}


/* --------------------------------------------------------------------------
   Environment

   The Supabase anon key is a public value — it ends up in the browser either
   way — but it is not committed. It is injected here at build time from the
   environment: Cloudflare Pages variables in production, a local .env in
   development. Source files carry __SUPABASE_URL__ / __SUPABASE_ANON_KEY__
   tokens and never the values themselves.
   -------------------------------------------------------------------------- */

function loadDotEnv() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    // A real environment variable always beats the file.
    if (process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadDotEnv();

const injected = {
  __SUPABASE_URL__: process.env.SUPABASE_URL || "",
  __SUPABASE_ANON_KEY__: process.env.SUPABASE_ANON_KEY || "",
  // Turnstile's SITE key, which is public and belongs in the markup. Its
  // partner secret is read by the Pages Functions from the environment and
  // never passes through the build. Without this value /verify renders a form
  // whose every submission is refused by /api/verify, which is why it is
  // treated as required rather than optional.
  __TURNSTILE_SITE_KEY__: process.env.TURNSTILE_SITE_KEY || ""
};

function injectEnv(text) {
  let out = text;
  for (const token of Object.keys(injected)) {
    out = out.split(token).join(injected[token]);
  }
  return out;
}

function walkFiles(dir, extensions, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, extensions, found);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}

/* --------------------------------------------------------------------------
   Build
   -------------------------------------------------------------------------- */

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const missing = [];

for (const item of publicPaths) {
  const src = path.join(root, item);
  if (!fs.existsSync(src)) {
    missing.push(item);
    continue;
  }
  fs.cpSync(src, path.join(dist, item), { recursive: true });
}

let processed = 0;
for (const file of walkHtml(dist, [])) {
  if (processHtml(file)) processed++;
}

// Env tokens are substituted after includes, so a partial can carry one too.
let injectedFiles = 0;
for (const file of walkFiles(dist, [".html", ".js"], [])) {
  const before = fs.readFileSync(file, "utf8");
  const after = injectEnv(before);
  if (after !== before) {
    fs.writeFileSync(file, after);
    injectedFiles++;
  }
}

// Report the environment variable names, not the internal token names.
const TOKEN_TO_ENV = {
  __SUPABASE_URL__: "SUPABASE_URL",
  __SUPABASE_ANON_KEY__: "SUPABASE_ANON_KEY",
  __TURNSTILE_SITE_KEY__: "TURNSTILE_SITE_KEY"
};
const missingEnv = Object.keys(injected)
  .filter((key) => !injected[key])
  .map((key) => TOKEN_TO_ENV[key] || key);
if (missingEnv.length) {
  const message =
    "Missing environment values: " +
    missingEnv.join(", ") +
    ". Set them in the Cloudflare Pages project, or in a local .env.";
  // A production deploy with no key would ship a dead enrollment form on the
  // one page that has to sell, so fail there. Locally and in CI — which
  // validates HTML and has no business holding secrets — warn and carry on.
  if (process.env.CF_PAGES) {
    console.error("\n  " + message + "\n");
    process.exit(1);
  }
  console.warn("\n  " + message + "\n  Forms will be inert in this build.\n");
}

if (missing.length) {
  console.warn(
    "\n  Declared in publicPaths but not yet built (skipped):\n" +
      missing.map(function (m) { return "    - " + m; }).join("\n") +
      "\n  These will not ship until the files exist.\n"
  );
}

console.log(
  "Built " + (publicPaths.length - missing.length) + " of " + publicPaths.length +
  " declared paths into dist/ - resolved includes in " + processed + " page(s)"
);
