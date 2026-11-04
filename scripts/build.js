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
  "intermediate-cohort",
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
  "pay",
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
  __TURNSTILE_SITE_KEY__: process.env.TURNSTILE_SITE_KEY || "",
  // Meta Pixel ID for the webinar/workshop pages. Public by nature, OPTIONAL:
  // empty means assets/js/workshop-tracking.js never loads the Pixel at all.
  // Accepted only if it is all digits, so a mistyped value cannot inject markup.
  __META_PIXEL_ID__: /^[0-9]{6,20}$/.test(process.env.META_PIXEL_ID || "") ? process.env.META_PIXEL_ID : "",
  // Optional, owner-verified support WhatsApp in international format. Empty
  // means the webinar pages point people to email instead of a phone number.
  __WORKSHOP_SUPPORT_WHATSAPP__: /^\+[1-9][0-9]{7,14}$/.test((process.env.WORKSHOP_SUPPORT_WHATSAPP || "").replace(/[\s-]/g, ""))
    ? process.env.WORKSHOP_SUPPORT_WHATSAPP.replace(/[\s-]/g, "") : ""
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

/* --------------------------------------------------------------------------
   Webinars and workshops: generated from content/workshops/*.json (which
   never ships). With no published session nothing is emitted at all: no
   route, no nav item, no sitemap entry. A published file that is incomplete,
   in the past, or carries a [PLACEHOLDER] fails the build. See
   scripts/workshops.js.
   -------------------------------------------------------------------------- */
const workshops = require("./workshops.js");
// WORKSHOP_CONTENT_DIR lets local QA and CI render the test fixtures. It is
// ignored on Cloudflare Pages, so a fixture can never reach production.
// This standalone review branch previews the webinar design without any data
// or payment services. Only this exact Cloudflare branch can render the examples.
const visualPreviewBranch = process.env.CF_PAGES_BRANCH === "webinar-visual-demo";
const workshopDir = visualPreviewBranch
  ? path.join(root, "preview", "workshops")
  : process.env.WORKSHOP_CONTENT_DIR && !process.env.CF_PAGES
    ? path.resolve(root, process.env.WORKSHOP_CONTENT_DIR)
    : path.join(root, "content", "workshops");
const workshopPaths = workshops.render(workshops.loadSessions(workshopDir), dist);
// Preview pages show the actual built design but NEVER contact Supabase or
// Paystack. Registration is visibly disabled; no user-entered details leave
// the browser. The ordinary feature branch and production builds are unchanged.
if (visualPreviewBranch) {
  const banner = '<div role="status" style="position:relative;z-index:1000;padding:13px 20px;text-align:center;background:#fff2cf;color:#442d08;border-bottom:2px solid #b47e17;font:700 14px/1.45 system-ui,sans-serif">VISUAL DEMO ONLY · Dates and prices are illustrative · Registration and payments disabled</div>';
  for (const route of workshopPaths.concat(["/workshops/registered"])) {
    const pageFile = path.join(dist, route.slice(1), "index.html");
    if (!fs.existsSync(pageFile)) continue;
    let html = fs.readFileSync(pageFile, "utf8");
    html = html.replace('<script src="/assets/js/workshop-tracking.js" defer></script>', "")
      .replace('<script src="/assets/js/workshops.js" defer></script>', "")
      .replace("</head>", '<meta name="robots" content="noindex,nofollow"></head>')
      .replace('<body class="ws-body">', '<body class="ws-body">' + banner)
      .replace('type="submit" data-ws-submit', 'type="button" data-ws-submit disabled aria-disabled="true"')
      .replace('<form class="ws-form" data-ws-form novalidate>', '<form class="ws-form" data-ws-form novalidate><p class="ws-note" role="note">This is a design preview. The registration form is visible for review but cannot submit.</p>')
      .replace('Checking your registration', 'Example confirmation screen')
      .replace('One moment while we confirm with our records.', 'This is an example of the confirmation page. No registration or payment occurred.');
    fs.writeFileSync(pageFile, html);
  }
}
const navItem = workshopPaths.length
  ? '<li><a href="/workshops" aria-current="{{n_workshops}}">Webinars and workshops</a></li>' : "";
const footItem = workshopPaths.length ? '<li><a href="/workshops">Webinars and workshops</a></li>' : "";
// The whole marker line goes when there is nothing to show, so no blank,
// whitespace-only line is left behind for html-validate to reject.
partialCache.set("header.html", readPartial("header.html").replace(/\n[ \t]*<!-- workshops-nav -->/, navItem ? "\n          " + navItem : ""));
partialCache.set("footer.html", readPartial("footer.html").replace(/\n[ \t]*<!-- workshops-footer -->/, footItem ? "\n          " + footItem : ""));
if (workshopPaths.length) {
  const sitemapFile = path.join(dist, "sitemap.xml");
  const entries = workshopPaths.map(function (p) {
    return "  <url>\n    <loc>" + workshops.ORIGIN + p + "</loc>\n  </url>\n";
  }).join("");
  fs.writeFileSync(sitemapFile, fs.readFileSync(sitemapFile, "utf8").replace("</urlset>", entries + "</urlset>"));
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

/* --------------------------------------------------------------------------
   Training administration: six independent URLs with one canonical source.
   The legacy admin scripts require a shared set of DOM IDs and event handlers,
   so building a separate DOM tree for each route could silently break payment,
   archive and enrollment operations. Instead each *physical* route gets the
   same authenticated shell with a data-admin-view that exposes only its own
   workspace. This has real URLs, direct links, refresh and no runtime router.
   No JS is needed to decide which workspace is visible.
   -------------------------------------------------------------------------- */
const adminViews = {
  enrollments: "Enrollments",
  payments: "Payments",
  credentials: "Credentials",
  studio: "Certificate Studio",
  verification: "Verification activity",
  workshops: "Webinars &amp; workshops"
};
const adminSource = path.join(dist, "admin/index.html");
if (fs.existsSync(adminSource)) {
  const template = fs.readFileSync(adminSource, "utf8");
  if (!template.includes('data-admin-view="overview"')) {
    throw new Error("Training admin source must declare the overview view");
  }
  for (const [view, title] of Object.entries(adminViews)) {
    const folder = path.join(dist, "admin", view);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "index.html"),
      template.replace('data-admin-view="overview"', 'data-admin-view="' + view + '"')
        .replace("<title>Overview — Bulletproof Automations Training</title>",
          "<title>" + title + " — Bulletproof Automations Training</title>")
    );
  }
}

// Report the environment variable names, not the internal token names.
const TOKEN_TO_ENV = {
  __SUPABASE_URL__: "SUPABASE_URL",
  __SUPABASE_ANON_KEY__: "SUPABASE_ANON_KEY",
  __TURNSTILE_SITE_KEY__: "TURNSTILE_SITE_KEY"
};
// Optional tokens: empty is a valid, deliberate state (no Pixel, no published
// WhatsApp number), so they must never fail a Cloudflare build.
const OPTIONAL_TOKENS = new Set(["__META_PIXEL_ID__", "__WORKSHOP_SUPPORT_WHATSAPP__"]);
const missingEnv = Object.keys(injected)
  .filter((key) => !injected[key] && !OPTIONAL_TOKENS.has(key))
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
console.log("Webinar and workshop pages: " + (workshopPaths.length ? workshopPaths.join(", ") : "none published, so none built"));
