/* Webinar and workshop pages: the build-time half.
 *
 * Since release 6 the pages themselves are rendered on request from the
 * database by functions/workshops/[[path]].js (markup in
 * functions/api/_workshop_pages.js), because workshops are created and edited
 * in /admin/workshops/ and must go live without a deploy.
 *
 * The build still owns what only the build can do: the site header, footer
 * and <head> come from partials/ through build-time includes. So it writes one
 * shell, dist/workshops/_shell.html, with placeholders the function fills in:
 * __WS_TITLE__, __WS_DESCRIPTION__, __WS_CANONICAL__ and <!-- ws-body -->.
 * The function refuses to serve the shell itself as a page. */

const fs = require("fs");
const path = require("path");

const ORIGIN = "https://training.bulletproofautomations.com";

const HEAD =
  '<!-- include: head.html title="__WS_TITLE__" description="__WS_DESCRIPTION__" canonical="__WS_CANONICAL__" -->\n' +
  '<link rel="preload" href="/assets/fonts/eb-garamond-600.woff2" as="font" type="font/woff2" crossorigin>\n' +
  '<link rel="stylesheet" href="/assets/css/workshops.css?v=20261111">\n' +
  '<script src="/assets/js/workshop-tracking.js" defer></script>\n' +
  '<script src="/assets/js/workshops.js?v=20261111" defer></script>';

const CONSENT_BAR =
  '<aside class="ws-consent" aria-label="Advert measurement" data-ad-consent hidden>\n' +
  '  <p>Can we measure which adverts bring people here? This uses Meta\'s tracking and sets cookies. Registration works the same either way.</p>\n' +
  '  <div class="ws-consent__actions"><button class="ws-btn ws-btn--small" type="button" data-ad-consent-allow>Allow</button>' +
  '<button class="ws-btn ws-btn--small ws-btn--quiet" type="button" data-ad-consent-deny>No thanks</button></div>\n' +
  '  <p class="ws-consent__more"><a href="/privacy">How we use this</a></p>\n' +
  '</aside>';

function shell() {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' + HEAD + '\n</head>\n' +
    '<body class="ws-body">\n<!-- include: header.html nav="workshops" -->\n' +
    '<!-- ws-body -->\n' + CONSENT_BAR + '\n<!-- include: footer.html -->\n</body>\n</html>\n';
}

/* Writes outDir/workshops/_shell.html and returns the public paths the build
   knows about (none: the sitemap function adds the live ones). */
function writeShell(outDir) {
  const base = path.join(outDir, "workshops");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "_shell.html"), shell());
  return [];
}

module.exports = { writeShell, shell, ORIGIN };
