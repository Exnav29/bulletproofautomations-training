export function parseRoster(input) {
  if (typeof input !== "string" || input.length > 250000)
    throw Error("CSV exceeds limit.");
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  input = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (!quoted && field) throw Error("Invalid CSV quote");
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw Error("Unclosed CSV quote");
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  const headers = (rows.shift() || []).map((s) => s.trim().toLowerCase());
  if (!headers.includes("full_name") || !headers.includes("email"))
    throw Error("CSV headers must include full_name,email.");
  if (rows.length > 100) throw Error("Import at most 100 graduates per batch.");
  const seen = new Set();
  return rows.map((r, i) => {
    if (r.length !== headers.length)
      throw Error("Wrong column count at row " + (i + 2));
    const obj = Object.fromEntries(headers.map((h, j) => [h, r[j]?.trim()]));
    const g = validateGraduate(obj);
    const key = (g.email || g.full_name).toLowerCase();
    if (seen.has(key)) throw Error("Duplicate graduate at row " + (i + 2));
    seen.add(key);
    return g;
  });
}
export function validateGraduate(g) {
  const full_name = String(g.full_name || "").trim(),
    email = String(g.email || "")
      .trim()
      .toLowerCase();
  if (
    full_name.length < 2 ||
    full_name.length > 150 ||
    /[\r\n\x00-\x1f]/.test(full_name)
  )
    throw Error("Graduate name must contain 2–150 characters.");
  if (email && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email))
    throw Error("Invalid email address.");
  return {
    full_name,
    email,
    publish_consent: g.publish_consent === true,
    allow_name_lookup: g.allow_name_lookup === true,
    enrollment_id: g.enrollment_id || null,
  };
}
export function emailMessage(g, snapshot, template) {
  if (!g.email) throw Error("Recipient email missing.");
  const vars = {
    name: g.full_name,
    first_name: g.full_name.split(" ")[0],
    course: snapshot.course_name,
    start_date: snapshot.start_date,
    end_date: snapshot.end_date,
    issue_date: snapshot.issue_date,
    credential_id: g.credential_id,
    url:
      "https://training.bulletproofautomations.com/verify/" + g.credential_id,
  };
  const replace = (s) =>
    String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
  return {
    to: g.email,
    subject: replace(template.subject),
    body: replace(template.body),
    attachment_name: g.credential_id + ".pdf",
  };
}
