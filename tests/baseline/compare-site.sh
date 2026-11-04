#!/usr/bin/env bash
# BASELINE: the built site must be byte-identical to main's, except for an explicit,
# reviewed list. Any other difference in an existing file fails.
#   tests/baseline/compare-site.sh <path-to-a-checkout-of-main>
set -euo pipefail
MAIN="$1"
ENVV=(SUPABASE_URL=https://baseline.supabase.co SUPABASE_ANON_KEY=baseline-anon TURNSTILE_SITE_KEY=baseline-ts)
(cd "$MAIN" && env "${ENVV[@]}" node scripts/build.js >/dev/null)
env "${ENVV[@]}" node scripts/build.js >/dev/null
# Reviewed, intended changes to EXISTING files (see docs/workshops-shared-changes.md):
ALLOWED='^\./(_headers|admin/(index|credentials/index|enrollments/index|payments/index|studio/index|verification/index)\.html|assets/css/admin-console\.css|assets/js/admin-console\.js)$'
fail=0
while IFS= read -r f; do
  if ! cmp -s "$MAIN/dist/$f" "dist/$f"; then
    if [[ "$f" =~ $ALLOWED ]]; then echo "changed (reviewed): $f"; else echo "UNEXPECTED CHANGE: $f"; fail=1; fi
  fi
done < <(cd "$MAIN/dist" && find . -type f | sort)
# _headers may only gain lines; every existing rule must survive unchanged.
if ! diff <(cat "$MAIN/dist/_headers") <(cat dist/_headers) | grep -q '^<'; then echo "_headers: additions only"; else echo "UNEXPECTED: _headers lost or changed existing lines"; fail=1; fi
exit $fail
