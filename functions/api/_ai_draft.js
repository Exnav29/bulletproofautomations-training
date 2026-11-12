/* Draft workshop page content with a free model on OpenRouter (release 7).
 *
 * The owner asked for OpenRouter's free models, chosen automatically because the
 * free list changes often. Every call reads the live model list
 * (GET /api/v1/models, public, cached here for 30 minutes), keeps the models
 * that cost nothing, read and write text and can hold a full page draft, and
 * ranks them: models that support structured JSON output first, then larger
 * and newer ones. The first draft that passes the checks below is returned;
 * anything else moves on to the next model, ending with OpenRouter's own free
 * router. Nothing is saved: the admin page fills the editor and the owner
 * reviews and saves it like any other edit.
 *
 * Needs OPENROUTER_API_KEY on the Pages project. A free OpenRouter account's key
 * is enough; free models carry a daily request limit and may log prompts, which
 * is acceptable here because everything sent is public marketing copy. */

const MODELS_TTL_MS = 30 * 60 * 1000;
let cache = { at: 0, models: null };

/* Local testing only, like the Calendar and mail overrides: honoured solely for
   127.0.0.1 or localhost. */
function api(env) {
  const b = String((env && env.OPENROUTER_API_BASE) || "");
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(b) ? b + "/api/v1" : "https://openrouter.ai/api/v1";
}

const isFree = function (m) {
  const p = m && m.pricing;
  return !!p && Number(p.prompt) === 0 && Number(p.completion) === 0 && (p.request === undefined || Number(p.request) === 0);
};
function paramsBillions(id) {
  let best = 0;
  String(id).toLowerCase().replace(/(\d+(?:\.\d+)?)b(?![a-z])/g, function (_, n) { best = Math.max(best, Number(n)); return _; });
  return best;
}

/** The free models worth trying, best first. Pure, so it can be tested on a saved list. */
export function rankFreeModels(models, now) {
  const t = now || Date.now();
  const list = (Array.isArray(models) ? models : []).filter(function (m) {
    const a = m.architecture || {}, top = m.top_provider || {};
    const out = a.output_modalities || [], inp = a.input_modalities || [];
    const expired = m.expiration_date && Date.parse(m.expiration_date) < t;
    const room = top.max_completion_tokens == null || Number(top.max_completion_tokens) >= 4000;
    return isFree(m) && m.id !== "openrouter/free" && !expired && room &&
      out.length === 1 && out[0] === "text" && inp.indexOf("text") !== -1 && Number(m.context_length) >= 16000;
  }).map(function (m) {
    const p = m.supported_parameters || [];
    const size = paramsBillions(m.id);
    const ageDays = m.created ? (t / 1000 - Number(m.created)) / 86400 : 999;
    let score = 0;
    if (p.indexOf("structured_outputs") !== -1) score += 40;
    else if (p.indexOf("response_format") !== -1) score += 20;
    if (size && size < 8) score -= 60;            // too small to write a page well
    else if (size && size < 20) score -= 20;
    else if (size >= 100) score += 15;
    if (ageDays < 120) score += 12; else if (ageDays < 365) score += 6;
    if (Number(m.context_length) >= 128000) score += 4;
    if (/preview|beta|experimental/i.test(m.id)) score -= 3;
    return { id: m.id, score: score, structured: p.indexOf("structured_outputs") !== -1, json: p.indexOf("response_format") !== -1 };
  }).sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); });
  // OpenRouter's own router across free models, last.
  if ((models || []).some(function (m) { return m.id === "openrouter/free"; })) list.push({ id: "openrouter/free", score: -100, structured: true, json: true });
  return list;
}

async function freeModels(env) {
  if (cache.models && Date.now() - cache.at < MODELS_TTL_MS) return cache.models;
  const res = await fetch(api(env) + "/models", { headers: { Accept: "application/json" } });
  if (!res.ok) { await res.text(); throw new Error("models " + res.status); }
  const body = await res.json();
  cache = { at: Date.now(), models: rankFreeModels(body && body.data) };
  return cache.models;
}

/* The page fields, as the admin editor and the public renderer use them. */
const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["summary", "description", "directory_line", "audience", "why", "outcomes", "leave_with", "run_of_show", "faq",
    "good_fit", "not_fit", "bring", "problem", "series_fit"],
  properties: {
    summary: { type: "string" }, description: { type: "string" }, directory_line: { type: "string" }, audience: { type: "string" },
    why: { type: "array", items: { type: "string" } }, outcomes: { type: "array", items: { type: "string" } },
    leave_with: { type: "array", items: { type: "string" } },
    run_of_show: { type: "array", items: { type: "object", additionalProperties: false, required: ["at", "title", "detail"],
      properties: { at: { type: "string" }, title: { type: "string" }, detail: { type: "string" } } } },
    faq: { type: "array", items: { type: "object", additionalProperties: false, required: ["q", "a"],
      properties: { q: { type: "string" }, a: { type: "string" } } } },
    good_fit: { type: "string" }, not_fit: { type: "string" }, bring: { type: "string" },
    problem: { type: "string" }, series_fit: { type: "string" }
  }
};

const RULES = [
  "You write public web page copy for Bulletproof Automations, an independent automation training provider based in the United States whose learners are mostly working professionals in Ghana.",
  "Voice: plainspoken, direct, specific, willing to say who it is not for. Sentence case. US English. No hype, no exclamation marks, no rhetorical questions in headings, and never the words unlock, transform, game-changing, supercharge or skyrocket.",
  "Never promise clients, income, contracts, jobs or results. Never imply that n8n, Make, Zapier, Microsoft or any other vendor endorses or is affiliated with the workshop.",
  "Never state a price, fee, discount, date, time, number of places or meeting link: the page shows those from the booking system. Do not invent testimonials, statistics or names.",
  "A workshop is training, not a certification. Say so if a question touches it.",
  "Return only a JSON object with exactly the requested fields. No markdown."
].join("\n");

function prompt(input) {
  const minutes = Number(input.duration_minutes) || 180;
  return [
    "Series: " + (input.series && input.series.name ? input.series.name : "(none)") + ".",
    input.series && input.series.positioning ? "Series positioning: " + input.series.positioning : "",
    input.series && Array.isArray(input.series.intro) && input.series.intro.length ? "Series introduction:\n" + input.series.intro.join("\n\n") : "",
    input.series_number ? "This is workshop " + input.series_number + " in the series." : "",
    "",
    "An approved page from the same series, as the model for tone, depth, length and structure (follow it closely, but write about the new topic):",
    JSON.stringify(input.example || {}, null, 1),
    "",
    "Write the page for this " + (input.kind === "webinar" ? "webinar" : "workshop") + ":",
    "Title: " + input.title,
    "What the owner says it covers: " + input.brief,
    "Length: " + minutes + " minutes, live online.",
    "",
    "Fields:",
    "- summary: two sentences, what someone can do after it.",
    "- description: one sentence under 155 characters, for search results.",
    "- directory_line: one short line for the list of workshops.",
    "- audience: one line, who it is for.",
    "- why: two or three short paragraphs on why this matters.",
    "- outcomes: five to seven things participants will be able to do, each starting with a verb.",
    "- leave_with: three to five concrete things participants receive or produce.",
    "- run_of_show: four to seven segments covering all " + minutes + " minutes, 'at' as elapsed time like 0:00, 0:45, 1:30" +
      (minutes >= 150 ? ", including one 15-minute break" : "") + ", each with a short title and one-line detail.",
    "- faq: five to seven common questions with direct answers.",
    "- good_fit and not_fit: a short paragraph each.",
    "- bring: what to prepare or bring, one or two sentences.",
    "- problem: one paragraph on the problem it solves, for the coming-soon page.",
    "- series_fit: one or two sentences on where it fits in the series."
  ].filter(function (x) { return x !== ""; }).join("\n");
}

function parse(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (err) { return null; }
}

/** Enough to be worth reviewing. Anything thinner moves on to the next model. */
export function usable(c) {
  if (!c || typeof c !== "object") return false;
  const arr = function (k, n) { return Array.isArray(c[k]) && c[k].filter(Boolean).length >= n; };
  return typeof c.summary === "string" && c.summary.trim().length >= 40 && arr("outcomes", 3) && arr("why", 1) &&
    arr("run_of_show", 3) && c.run_of_show.every(function (r) { return r && r.at && r.title; }) &&
    arr("faq", 3) && c.faq.every(function (f) { return f && f.q && f.a; });
}

/* Time. Cloudflare closes any request that has not answered within 100 seconds
   and hands the browser its own error page (HTTP 524) instead of ours. Four
   models at 60 seconds each could take four minutes, so a slow free model
   produced that page and the admin could only say "The change was refused."
   The whole draft now fits a budget well inside the limit, and each model gets
   at most what is left of it. */
const BUDGET_MS = 80000, PER_MODEL_MS = 45000, MIN_TRY_MS = 8000;

/* A model that just timed out or failed is tried last for a while, so the next
   press does not wait on it again. Per isolate, which is enough. */
const RECENT_FAIL_MS = 15 * 60 * 1000;
const failedAt = new Map();
function preferWorking(models, now) {
  const recent = function (m) { const t = failedAt.get(m.id); return t && now - t < RECENT_FAIL_MS ? 1 : 0; };
  return models.map(function (m, i) { return { m: m, i: i }; })
    .sort(function (a, b) { return recent(a.m) - recent(b.m) || a.i - b.i; }).map(function (x) { return x.m; });
}

/** { ok: true, model, content } or { ok: false, error, tried }. Never throws. */
export async function draftContent(env, input, origin, limits) {
  const started = Date.now();
  const budget = (limits && limits.budgetMs) || BUDGET_MS, perModel = (limits && limits.perModelMs) || PER_MODEL_MS;
  const minTry = (limits && limits.minTryMs) || MIN_TRY_MS;
  if (!env.OPENROUTER_API_KEY) {
    return { ok: false, error: "AI drafting isn't connected. Add OPENROUTER_API_KEY to the Cloudflare Pages project (Production and Preview), then redeploy." };
  }
  let models;
  try { models = await freeModels(env); }
  catch (err) { return { ok: false, error: "OpenRouter's model list couldn't be read just now. Try again in a minute." }; }
  if (!models.length) return { ok: false, error: "OpenRouter lists no free models suitable for writing a page right now. Try again later." };

  const tried = [];
  for (const m of preferWorking(models, Date.now()).slice(0, 4)) {
    const left = budget - (Date.now() - started);
    if (left < minTry) { tried.push("no time left for " + m.id); break; }
    const body = {
      model: m.id, max_tokens: 6000, temperature: 0.4,
      messages: [{ role: "system", content: RULES }, { role: "user", content: prompt(input) }]
    };
    if (m.structured) body.response_format = { type: "json_schema", json_schema: { name: "workshop_page", strict: true, schema: SCHEMA } };
    else if (m.json) body.response_format = { type: "json_object" };
    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); }, Math.min(perModel, left));
    let ok = false;
    try {
      const res = await fetch(api(env) + "/chat/completions", {
        method: "POST", signal: ctl.signal,
        headers: { Authorization: "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json",
          "HTTP-Referer": origin || "https://training.bulletproofautomations.com", "X-Title": "Bulletproof Automations admin" },
        body: JSON.stringify(body)
      });
      const out = await res.json().catch(function () { return null; });
      if (!res.ok) { tried.push(m.id + " (" + res.status + ")"); continue; }
      const msg = out && out.choices && out.choices[0] && out.choices[0].message;
      const content = parse(msg && msg.content);
      if (!usable(content)) { tried.push(m.id + " (incomplete draft)"); continue; }
      ok = true;
      return { ok: true, model: (out && out.model) || m.id, content: content };
    } catch (err) {
      tried.push(m.id + (err && err.name === "AbortError" ? " (timed out)" : " (unreachable)"));
    } finally {
      clearTimeout(timer);
      if (ok) failedAt.delete(m.id); else failedAt.set(m.id, Date.now());
    }
  }
  return { ok: false, error: "No free model produced a usable draft in time (" + tried.join(", ") + "). Nothing was changed. Press Generate again: models that just failed are tried last.", tried: tried };
}

export function resetModelCache() { cache = { at: 0, models: null }; failedAt.clear(); }
