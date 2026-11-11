#!/usr/bin/env bash
# BASELINE: the built site must be byte-identical to main's, except for an explicit,
# reviewed list. Any other difference in an existing file fails.
#   tests/baseline/compare-site.sh <path-to-a-checkout-of-main>
set -euo pipefail
MAIN="$1"
ENVV=(SUPABASE_URL=https://baseline.supabase.co SUPABASE_ANON_KEY=baseline-anon TURNSTILE_SITE_KEY=baseline-ts)
(cd "$MAIN" && env "${ENVV[@]}" node scripts/build.js >/dev/null)
env "${ENVV[@]}" node scripts/build.js >/dev/null
# Release 6: workshop pages are rendered on request from the database, so the build
# no longer writes them. Render the same pages from the real rows (as of today, like
# main's build) so every one is still compared with main's.
RENDER_NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)" node tests/render-workshop-pages.mjs real >/dev/null
# Reviewed, intended changes to EXISTING files (see docs/workshops-shared-changes.md).
# Release 6: the workshop desk (admin/workshops) and workshop 01's wording for
# referral codes for anyone and the certificate applied at once.
# Two-step registration (November 2026): the workshop page's short form and the
# workshop stylesheet; the version tag on the workshop stylesheet and script is
# ignored on both sides below, so every other workshop page must still match.
ALLOWED='^\./(_headers|admin/(index|credentials/index|enrollments/index|payments/index|studio/index|verification/index|workshops/index)\.html|assets/css/(admin-console|workshops)\.css|assets/js/(admin-console|admin-workshops|workshops)\.js|workshops/what-to-charge-for-automation/index\.html)$'
# Publishing a webinar session (content/workshops) adds exactly two things to existing files:
# one "Webinars and workshops" nav/footer line per page, and /workshops entries in the sitemap.
# The refund policy page gains section 23, "Webinars and workshops", and its contents entry.
# Those additions are removed before comparing, so sections 1 to 22 (the cohort and
# certification terms) must be byte-identical to main; any other difference still fails.
strip_workshops() {
  node -e '
    const fs = require("fs");
    let t = fs.readFileSync(process.argv[1], "utf8");
    t = t.replace(/\r?\n[ \t]*<li><a href="\/workshops"( aria-current="[^"]*")?>Webinars and workshops<\/a><\/li>/g, "");
    t = t.replace(/\n[ \t]*<url>\s*<loc>https:\/\/training\.bulletproofautomations\.com\/workshops[^<]*<\/loc>\s*<\/url>/g, "");
    t = t.replace(/\r?\n[ \t]*<li><a href="#workshops">Webinars and workshops<\/a><\/li>/g, "");
    t = t.replace(/\r?\n[ \t]*<h2 class="section__title policy__h" id="workshops">[\s\S]*?(?=\r?\n[ \t]*<\/div>)/, "");
    t = t.replace(/(\/assets\/(css\/workshops\.css|js\/workshops\.js))\?v=[0-9]+/g, "$1");
    process.stdout.write(t);' "$1"
}
fail=0
while IFS= read -r f; do
  if ! cmp -s "$MAIN/dist/$f" "dist/$f"; then
    if [[ "$f" =~ $ALLOWED ]]; then echo "changed (reviewed): $f"
    # Only the CSV formula escaping (shared change 9); the rest must match main exactly.
    elif [[ "$f" == "./assets/js/admin.js" ]] && cmp -s <(tr -d '\r' < "$MAIN/dist/$f") <(node tests/baseline/strip-csv-escape.js "dist/$f" | tr -d '\r'); then
      echo "changed only by CSV formula escaping (reviewed): $f"
    # Stripped on both sides: since release 6 the sitemap's workshop entries are added on request.
    elif [[ "$f" =~ \.(html|xml)$ ]] && cmp -s <(strip_workshops "$MAIN/dist/$f") <(strip_workshops "dist/$f"); then workshops_only=$((${workshops_only:-0}+1))
    else echo "UNEXPECTED CHANGE: $f"; fail=1; fi
  fi
done < <(cd "$MAIN/dist" && find . -type f | sort)
echo "changed only by the published-workshops nav, footer and sitemap entries: ${workshops_only:-0} files"
# _headers may only gain lines; every existing rule must survive unchanged.
if ! diff <(cat "$MAIN/dist/_headers") <(cat dist/_headers) | grep -q '^<'; then echo "_headers: additions only"; else echo "UNEXPECTED: _headers lost or changed existing lines"; fail=1; fi
exit $fail
