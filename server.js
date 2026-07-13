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

function cardRef(card) {
  if (!card) return null;
  return {
    name: card.cardName,
    title: card.title || "",
    set: card.defaultExpansionAbbreviation || "",
    number: card.defaultCardNumber || "",
  };
}

// swudb.com's own API only exposes aspects as undocumented numeric codes, so
// colors are resolved from the official api.swu-db.com card data instead
// (one fetch per set, cached for the process lifetime, keyed by card number).
const setAspectsCache = new Map();

async function getSetAspects(set) {
  const key = set.toLowerCase();
  if (setAspectsCache.has(key)) return setAspectsCache.get(key);
  const map = new Map();
  try {
    const data = await httpsGetJson(`https://api.swu-db.com/cards/${key}?format=json`);
    for (const c of data.data || []) map.set(c.Number, c.Aspects || []);
  } catch (err) {
    console.error(`Could not load aspects for set ${set}: ${err.message}`);
  }
  setAspectsCache.set(key, map);
  return map;
}

async function resolveAspects(ref) {
  if (!ref || !ref.set || !ref.number) return [];
  const map = await getSetAspects(ref.set);
  return map.get(ref.number) || [];
}

async function syncDecks({ format, limit }) {
  if (syncInProgress) throw new Error("Un import est déjà en cours.");
  syncInProgress = true;
  try {
    const decks = loadDecks();
    let skip = 0;
    let imported = 0;
    while (imported < limit) {
      const searchUrl = `https://swudb.com/api/decks/search?` +
        `skip=${skip}&sortby=hot` + (format ? `&format=${encodeURIComponent(format)}` : "");
      const page = await httpsGetJson(searchUrl);
      const summaries = page.decks || [];
      if (!summaries.length) break;

      for (const summary of summaries) {
        if (imported >= limit) break;
        await sleep(SYNC_DELAY_MS);
        try {
          const deck = await httpsGetJson(`https://swudb.com/api/deck/${summary.deckId}`);
          const leaderRef = cardRef(deck.leader);
          const secondLeaderRef = cardRef(deck.secondLeader);
          const baseRef = cardRef(deck.base);
          const [leaderAspects, secondLeaderAspects, baseAspects] = await Promise.all([
            resolveAspects(leaderRef), resolveAspects(secondLeaderRef), resolveAspects(baseRef),
          ]);
          decks[summary.deckId] = {
            deckId: summary.deckId,
            deckName: deck.deckName,
            authorName: deck.authorName,
            deckFormat: deck.deckFormat,
            leader: leaderRef,
            secondLeader: secondLeaderRef,
            base: baseRef,
            colors: [...new Set([...leaderAspects, ...secondLeaderAspects, ...baseAspects])],
            likeCount: deck.likeCount,
            publishDate: deck.publishDate,
            cards: (deck.shuffledDeck || []).map((entry) => ({
              ...cardRef(entry.card),
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

// Older data/decks.json files stored leader/base as a plain name string
// instead of a {name,title,set,number} ref — normalize so re-searching an
// unsynced file doesn't crash the server.
function normalizeRef(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return { name: ref, title: "", set: "", number: "" };
  return ref;
}

function matchesInDeck(deck, needle) {
  const matches = [];
  const check = (rawRef, role) => {
    const ref = normalizeRef(rawRef);
    if (ref && ref.name && ref.name.toLowerCase().includes(needle)) matches.push({ role, ...ref });
  };
  check(deck.leader, "Leader");
  check(deck.secondLeader, "Leader 2");
  check(deck.base, "Base");
  for (const c of deck.cards || []) {
    if (c.name && c.name.toLowerCase().includes(needle)) matches.push({ role: "Deck", ...c });
  }
  return matches;
}

function toResult(deck, matches) {
  const leaderRef = normalizeRef(deck.leader);
  const baseRef = normalizeRef(deck.base);
  return {
    deckId: deck.deckId,
    deckName: deck.deckName,
    authorName: deck.authorName,
    deckFormat: deck.deckFormat,
    likeCount: deck.likeCount,
    publishDate: deck.publishDate,
    leaderName: leaderRef && leaderRef.name,
    leaderSet: leaderRef && leaderRef.set,
    leaderNumber: leaderRef && leaderRef.number,
    baseName: baseRef && baseRef.name,
    baseSet: baseRef && baseRef.set,
    baseNumber: baseRef && baseRef.number,
    colors: deck.colors || [],
    matches,
  };
}

// Separate multiple card names with a comma or a "+" to require all of them
// (AND) in the same deck. An empty query lists every deck (e.g. to sort by
// favorites without filtering by card).
function findDecksByCard(query, colors) {
  const decks = loadDecks();
  const needles = query.split(/[,+]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const wantedColors = (colors || []).map((c) => c.trim()).filter(Boolean);
  const results = [];
  for (const deck of Object.values(decks)) {
    if (wantedColors.length) {
      const deckColors = deck.colors || [];
      if (!wantedColors.every((c) => deckColors.includes(c))) continue;
    }
    if (!needles.length) {
      results.push(toResult(deck, []));
      continue;
    }
    const matchesByNeedle = needles.map((needle) => matchesInDeck(deck, needle));
    if (matchesByNeedle.every((m) => m.length > 0)) {
      results.push(toResult(deck, matchesByNeedle.flat()));
    }
  }
  return results;
}

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

function handleRequest(req, res) {
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

  if (url.pathname === "/api/decks/status") {
    let count = 0;
    let lastSyncedAt = null;
    try {
      count = Object.keys(loadDecks()).length;
      lastSyncedAt = fs.statSync(DECKS_FILE).mtime.toISOString();
    } catch { /* no decks.json yet */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count, lastSyncedAt }));
    return;
  }

  if (url.pathname === "/api/decks/by-card") {
    const q = url.searchParams.get("q") || "";
    const colors = (url.searchParams.get("colors") || "").split(",").filter(Boolean);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ decks: findDecksByCard(q, colors) }));
    return;
  }

  if (url.pathname === "/api/decks" && req.method === "DELETE") {
    if (syncInProgress) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Un import est en cours, réessaie une fois terminé." }));
      return;
    }
    fs.rmSync(DECKS_FILE, { force: true });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ cleared: true }));
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
}

server.listen(PORT, () => {
  console.log(`SWU Card Finder running at http://localhost:${PORT}`);
});
