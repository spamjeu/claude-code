// Minimal static file + API proxy server, no dependencies.
//
// Why this exists: api.swu-db.com's actual GET responses don't carry an
// Access-Control-Allow-Origin header (only its OPTIONS preflight does), so
// any direct fetch() from a browser is blocked by CORS regardless of how
// index.html itself is served. This proxies /api/cards/search to the real
// API server-side (no CORS involved between servers) and serves it back
// same-origin to the page.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/cards/search") {
    const upstream = `https://api.swu-db.com/cards/search${url.search}`;
    https.get(upstream, (upRes) => {
      res.writeHead(upRes.statusCode, { "content-type": "application/json" });
      upRes.pipe(res);
    }).on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Upstream request failed: ${err.message}` }));
    });
    return;
  }

  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.join(ROOT, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ""));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`SWU Card Finder running at http://localhost:${PORT}`);
});
