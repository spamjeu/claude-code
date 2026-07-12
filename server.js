// Minimal static file + API proxy server, no dependencies.
//
// Why this exists: api.swu-db.com's actual GET responses don't carry an
// Access-Control-Allow-Origin header (only its OPTIONS preflight does), so
// any direct fetch() from a browser is blocked by CORS regardless of how
// index.html itself is served. This proxies /api/cards/search to the real
// API server-side (no CORS involved between servers) and serves it back
// same-origin to the page.
//
// It also builds a small local deck index (data/decks.json) by calling
// swudb.com's own (undocumented, but unauthenticated) deck-search/deck-detail
// endpoints server-side, since neither api.swu-db.com nor swudb.com expose a
// documented public API to look up "which decks play card X". This is a
// personal/local tool: syncing is manual, rate-limited, and capped.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const DECKS_FILE = path.join(ROOT, "data", "decks.json");
const SYNC_DELAY_MS = 200;

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0" } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Invalid JSON from ${url}: ${err.message}`)); }
      });
    }).on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDecks() {
  try { return JSON.parse(fs.readFileSync(DECKS_FILE, "utf8")); }
  catch { return {}; }
}

function saveDecks(decks) {
  fs.mkdirSync(path.dirname(DECKS_FILE), { recursive: true });
  fs.writeFileSync(DECKS_FILE, JSON.stringify(decks, null, 1));
}

let syncInProgress = false;

async function syncDecks({ format, limit }) {
  if (syncInProgress) throw new Error("Un import est déjà en cours.");
  syncInProgress = true;
  try {
    const decks = loadDecks();
    let skip = 0;
    let imported = 0;
    while (imported < limit) {
      const searchUrl = `https://swudb.com/api/decks/search?` +
        `skip=${skip}&sortby=new` + (format ? `&format=${encodeURIComponent(format)}` : "");
      const page = await httpsGetJson(searchUrl);
      const summaries = page.decks || [];
      if (!summaries.length) break;

      for (const summary of summaries) {
        if (imported >= limit) break;
        await sleep(SYNC_DELAY_MS);
        try {
          const deck = await httpsGetJson(`https://swudb.com/api/deck/${summary.deckId}`);
          decks[summary.deckId] = {
            deckId: summary.deckId,
            deckName: deck.deckName,
            authorName: deck.authorName,
            deckFormat: deck.deckFormat,
            leader: deck.leader && deck.leader.cardName,
            secondLeader: deck.secondLeader && deck.secondLeader.cardName,
            base: deck.base && deck.base.cardName,
            likeCount: deck.likeCount,
            publishDate: deck.publishDate,
            cards: (deck.shuffledDeck || []).map((entry) => ({
              name: entry.card.cardName,
              count: entry.count,
            })),
          };
          imported++;
        } catch (err) {
          console.error(`Skipping deck ${summary.deckId}: ${err.message}`);
        }
      }

      if (page.endOfResults) break;
      skip += summaries.length;
      await sleep(SYNC_DELAY_MS);
    }
    saveDecks(decks);
    return { imported, total: Object.keys(decks).length };
  } finally {
    syncInProgress = false;
  }
}

function findDecksByCard(query) {
  const decks = loadDecks();
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return Object.values(decks)
    .map((deck) => {
      const match = deck.cards.find((c) => c.name.toLowerCase().includes(needle));
      if (!match) return null;
      const { cards, ...summary } = deck;
      return { ...summary, matchedCard: match.name, matchedCount: match.count };
    })
    .filter(Boolean);
}

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

  if (url.pathname === "/api/decks/sync" && req.method === "POST") {
    const format = url.searchParams.get("format") || "Premier";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);
    syncDecks({ format, limit })
      .then((result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (url.pathname === "/api/decks/by-card") {
    const q = url.searchParams.get("q") || "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ decks: findDecksByCard(q) }));
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
