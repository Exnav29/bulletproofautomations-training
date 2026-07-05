const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const publicPaths = [
  "index.html",
  "assets",
  "admin",
  "nfc",
  "n8n-foundations",
  "n8n-automation-builder-pathway",
  "price-by-value",
  "thank-you",
  "robots.txt",
  "sitemap.xml"
];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

for (const item of publicPaths) {
  fs.cpSync(path.join(root, item), path.join(dist, item), { recursive: true });
}
