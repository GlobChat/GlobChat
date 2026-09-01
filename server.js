/*
 * GlobChat development/LAN server.
 *
 * Static file server with the caching semantics the app expects:
 *   - HTML/CSS/JS are served `Cache-Control: no-cache` with an ETag, so
 *     refreshes revalidate (304) instead of re-downloading — this is what
 *     lets the app distinguish a soft reload from a hard refresh.
 *   - Images may be heuristically cached; they are cosmetic.
 *
 * Usage: node server.js   (PORT env var overrides 8080; binds 0.0.0.0)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500);
        res.end("Server error");
        return;
      }

      const etag = 'W/"' + stats.size + "-" + Math.floor(stats.mtimeMs) + '"';
      const ext = path.extname(filePath).toLowerCase();
      const headers = {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
        ETag: etag,
        Date: new Date().toUTCString()
      };

      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }

      res.writeHead(200, headers);
      res.end(data);
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`globchat serving ${ROOT}`);
  console.log(`  local:   http://localhost:${PORT}/`);
  console.log(`  network: http://<this-machine's-LAN-IP>:${PORT}/`);
});
