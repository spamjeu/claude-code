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
const META_CACHE_MS = 60 * 60 * 1000;
const SYNC_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// swustats.net buckets stats into 7-day "weeks" numbered from an undocumented
// anchor (Wk 0 = 2025-09-20, per a hardcoded `currentWeek` constant found in
// that site's own front-end JS — there is no API field that exposes this
// scheme, so treat it as fragile/inferred, not documented). Ashes of the
// Empire (ASH) released 2026-07-11. Passing this as `startWeek` with no
// `endWeek` to swustats.net's stat APIs gets "ASH season onward" without us
// tracking "current week" ourselves.
// UPDATE WHEN A NEW SET BECOMES THE SEASON TO ISOLATE: change
// ASH_RELEASE_DATE_MS to the new set's release date (and re-verify the week
// anchor still holds, in case swustats.net ever changes its own numbering).
const SWUSTATS_WEEK_ANCHOR_MS = Date.UTC(2025, 8, 20);
const ASH_RELEASE_DATE_MS = Date.UTC(2026, 6, 11);
const ASH_START_WEEK = Math.floor((ASH_RELEASE_DATE_MS - SWUSTATS_WEEK_ANCHOR_MS) / (7 * 24 * 60 * 60 * 1000));
// Exposed to the client alongside stats so the UI can show what period the
// numbers cover (e.g. "depuis le 11/07/2026") instead of just "ASH".
const ASH_SEASON_START_ISO = new Date(ASH_RELEASE_DATE_MS).toISOString().slice(0, 10);

// Milliseconds until another sync is allowed, or 0 if one can start now.
function syncCooldownRemaining() {
  try {
    const age = Date.now() - fs.statSync(DECKS_FILE).mtime.getTime();
    return Math.max(0, SYNC_COOLDOWN_MS - age);
  } catch {
    return 0; // no decks.json yet
  }
}

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
// aspects are resolved from the official api.swu-db.com data instead (one
// fetch per set, cached for the process lifetime, keyed by card number).
// api.swu-db.com's per-set endpoint is very slow (6-14s observed) so the
// cache stores the in-flight *promise*, not just the resolved value —
// concurrent lookups for the same not-yet-cached set share one fetch instead
// of each kicking off their own.
const setAspectsCache = new Map();

function getSetAspects(set) {
  const key = set.toLowerCase();
  if (setAspectsCache.has(key)) return setAspectsCache.get(key);
  const promise = (async () => {
    const map = new Map();
    try {
      const data = await httpsGetJson(`https://api.swu-db.com/cards/${key}?format=json`);
      for (const c of data.data || []) map.set(c.Number, c.Aspects || []);
    } catch (err) {
      console.error(`Could not load aspects for set ${set}: ${err.message}`);
    }
    return map;
  })();
  setAspectsCache.set(key, promise);
  return promise;
}

async function resolveAspects(ref) {
  if (!ref || !ref.set || !ref.number) return [];
  const map = await getSetAspects(ref.set);
  return map.get(ref.number) || [];
}

// Buckets a deck's maindeck cards by cost into a 0..6 histogram (6 = "6 or
// more"), weighted by copy count, for a mana-curve display. swudb.com's own
// deck API already includes each card's cost inline (shuffledDeck[].card.cost)
// so this needs no extra lookup against api.swu-db.com's slow per-set endpoint.
function computeManaCurve(shuffledDeck) {
  const curve = [0, 0, 0, 0, 0, 0, 0];
  for (const entry of shuffledDeck || []) {
    if (!entry.count) continue; // sideboard-only copy, not in the 50-card deck
    const cost = parseInt(entry.card && entry.card.cost, 10);
    if (Number.isNaN(cost)) continue;
    curve[Math.min(cost, 6)] += entry.count;
  }
  return curve;
}

// Meta presence (leader/base archetype win rate) from swustats.net's public
// Deck Meta Stats API, scoped to the ASH season via ASH_START_WEEK — cached
// for an hour since it's a side-panel stat, not something that needs to be
// live per search. Unlike the previous source (swumetastats.com, which
// silently ignores season filters and always returns an all-time mix), this
// API has no metaShare field, only numPlays (raw count) and a
// string-percentage winRate — see metaBadgeHtml() in index.html for how
// that's rendered.
//
// Deliberately NOT passing consolidate=1: that flag merges every
// mechanically-equivalent "common" base (same color+type) into a single row
// under one arbitrary representative base name/image, which breaks the
// name-based matching in loadMetaArchetypes()/metaFor() (index.html) for any
// deck whose actual base isn't that representative one — e.g. "Nevarro City,
// Restored" and "City in the Clouds" both silently disappeared into a
// "Shield Generator Complex" bucket under consolidate=1, showing no stats
// for real decks that do have data. consolidate=0 (the default) keeps one
// row per exact base, matching how local decks are keyed.
let metaArchetypesCache = { data: null, fetchedAt: 0 };

async function getMetaArchetypes() {
  const age = Date.now() - metaArchetypesCache.fetchedAt;
  if (metaArchetypesCache.data && age < META_CACHE_MS) return metaArchetypesCache.data;
  try {
    const data = await httpsGetJson(
      `https://swustats.net/TCGEngine/Stats/DeckMetaStatsAPI.php?startWeek=${ASH_START_WEEK}&format=Premier`
    );
    metaArchetypesCache = { data: Array.isArray(data) ? data : [], fetchedAt: Date.now() };
  } catch (err) {
    console.error(`Could not load meta archetypes: ${err.message}`);
    if (!metaArchetypesCache.data) metaArchetypesCache = { data: [], fetchedAt: Date.now() };
  }
  return metaArchetypesCache.data;
}

// Per-card stats (win rate when included/played/resourced) from swustats.net's
// public Card Meta Stats API, scoped to ASH_START_WEEK (same season constant
// as getMetaArchetypes(), so both stats sources stay consistent). Cached for
// an hour, same pattern as metaArchetypesCache.
let cardStatsCache = { data: null, fetchedAt: 0 };

async function getCardStats() {
  const age = Date.now() - cardStatsCache.fetchedAt;
  if (cardStatsCache.data && age < META_CACHE_MS) return cardStatsCache.data;
  try {
    const data = await httpsGetJson(
      `https://swustats.net/TCGEngine/APIs/CardMetaStatsAPI.php?startWeek=${ASH_START_WEEK}`
    );
    cardStatsCache = { data: Array.isArray(data) ? data : [], fetchedAt: Date.now() };
  } catch (err) {
    console.error(`Could not load card stats: ${err.message}`);
    if (!cardStatsCache.data) cardStatsCache = { data: [], fetchedAt: Date.now() };
  }
  return cardStatsCache.data;
}

const SYNC_BATCH_SIZE = 5;
let syncProgress = { active: false, imported: 0, total: 0 };

async function syncOneDeck(decks, summary) {
  const deck = await httpsGetJson(`https://swudb.com/api/deck/${summary.deckId}`);
  const leaderRef = cardRef(deck.leader);
  const secondLeaderRef = cardRef(deck.secondLeader);
  const baseRef = cardRef(deck.base);
  const cards = (deck.shuffledDeck || []).map((entry) => ({
    ...cardRef(entry.card),
    count: entry.count,
  }));
  const [leaderAspects, secondLeaderAspects, baseAspects] = await Promise.all([
    resolveAspects(leaderRef), resolveAspects(secondLeaderRef), resolveAspects(baseRef),
  ]);
  const manaCurve = computeManaCurve(deck.shuffledDeck);
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
    cards,
    manaCurve,
  };
}

// Decks within a page are fetched in small concurrent batches (instead of
// strictly one at a time) to cut wall-clock time — still paced with a sleep
// between batches so we don't hammer swudb.com's undocumented API.
async function syncDecks({ format, limit }) {
  if (syncInProgress) throw new Error("Un import est déjà en cours.");
  syncInProgress = true;
  syncProgress = { active: true, imported: 0, total: limit };
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

      let i = 0;
      while (i < summaries.length && imported < limit) {
        const batch = summaries.slice(i, i + Math.min(SYNC_BATCH_SIZE, limit - imported));
        i += batch.length;
        const results = await Promise.allSettled(batch.map((summary) => syncOneDeck(decks, summary)));
        results.forEach((r, idx) => {
          if (r.status === "fulfilled") imported++;
          else console.error(`Skipping deck ${batch[idx].deckId}: ${r.reason.message}`);
        });
        syncProgress.imported = imported;
        saveDecks(decks); // write incrementally so /api/decks/by-card sees growing data mid-sync
        await sleep(SYNC_DELAY_MS);
      }

      if (page.endOfResults) break;
      skip += summaries.length;
      await sleep(SYNC_DELAY_MS);
    }
    saveDecks(decks);
    return { imported, total: Object.keys(decks).length };
  } finally {
    syncInProgress = false;
    syncProgress.active = false;
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
    leaderTitle: leaderRef && leaderRef.title,
    leaderSet: leaderRef && leaderRef.set,
    leaderNumber: leaderRef && leaderRef.number,
    baseName: baseRef && baseRef.name,
    baseTitle: baseRef && baseRef.title,
    baseSet: baseRef && baseRef.set,
    baseNumber: baseRef && baseRef.number,
    colors: deck.colors || [],
    manaCurve: deck.manaCurve || null,
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
    const cooldown = syncCooldownRemaining();
    if (cooldown > 0) {
      const minutes = Math.ceil(cooldown / 60000);
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Prochaine synchro possible dans ${minutes} min.`, cooldownMs: cooldown }));
      return;
    }
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

  if (url.pathname === "/api/decks/sync/progress") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(syncProgress));
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
    res.end(JSON.stringify({ count, lastSyncedAt, cooldownMs: syncCooldownRemaining() }));
    return;
  }

  if (url.pathname === "/api/meta/archetypes") {
    getMetaArchetypes()
      .then((archetypes) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ archetypes, seasonStart: ASH_SEASON_START_ISO }));
      })
      .catch((err) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (url.pathname === "/api/cards/stats") {
    getCardStats()
      .then((cards) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cards, seasonStart: ASH_SEASON_START_ISO }));
      })
      .catch((err) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
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
    const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript"
      : ext === ".css" ? "text/css" : ext === ".png" ? "image/png" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log(`SWU Card Finder running at http://localhost:${PORT}`);
});
