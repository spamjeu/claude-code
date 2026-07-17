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

// Minimal .env loader (no dependency): sets process.env from KEY=VALUE lines
// in an untracked .env file at the repo root. Used for CARDTRADER_TOKEN,
// which must never be committed — see .gitignore.
function loadDotEnv() {
  let content;
  try { content = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); }
  catch { return; }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
loadDotEnv();

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const DECKS_FILE = path.join(ROOT, "data", "decks.json");
const STATS_FILE = path.join(ROOT, "data", "stats.json");
const CATALOG_FILE = path.join(ROOT, "data", "cardtrader-catalog.json");
const PRICES_FILE = path.join(ROOT, "data", "prices.json");
const SYNC_DELAY_MS = 200;
const META_CACHE_MS = 60 * 60 * 1000;
const SYNC_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// CardTrader (cardtrader.com) is used for deck price estimates: EU
// marketplace, EUR prices, free-account Bearer token (unlike Cardmarket,
// which blocks server-side access behind Cloudflare and gates its real API
// behind a professional-seller developer program). Game 20 = Star Wars
// Unlimited, category 232 = "Star Wars Singles" (excludes sealed product).
// Only the 8 mainline sets are indexed — CardTrader also lists variant/promo
// expansions (xash, ashp, starwars, ...) that our deck data never references,
// since swudb.com always reports a card's primary set.
const CARDTRADER_GAME_ID = 20;
const CARDTRADER_SINGLES_CATEGORY_ID = 232;
const CARDTRADER_SET_CODES = ["sor", "shd", "twi", "jtl", "lof", "sec", "law", "ash"];
const CARDTRADER_DELAY_MS = 150;
const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000; // the card catalog itself is near-static
const PRICE_REFRESH_MS = 2 * 60 * 60 * 1000; // live prices move; same cadence as deck sync

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

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "user-agent": "Mozilla/5.0", ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Invalid JSON from ${url}: ${err.message}`)); }
      });
    }).on("error", reject);
  });
}

function cardTraderGetJson(pathAndQuery) {
  return httpsGetJson(`https://api.cardtrader.com/api/v2${pathAndQuery}`, {
    authorization: `Bearer ${process.env.CARDTRADER_TOKEN}`,
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

// Meta/card stats (swustats.net) are synced independently from the deck
// import button: they run on their own recurring background timer and
// persist to data/stats.json, decoupled from data/decks.json's manual
// sync/cooldown cycle. Requests just read the in-memory cache — no
// per-request network fetch, no coupling to the "Importer" click.
let statsCache = { archetypes: [], cards: [], fetchedAt: 0 };

function loadStatsFile() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); }
  catch { return null; }
}

function saveStatsFile(stats) {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 1));
}

// Meta presence (leader/base archetype win rate) from swustats.net's public
// Deck Meta Stats API, scoped to the ASH season via ASH_START_WEEK. Unlike
// the previous source (swumetastats.com, which silently ignores season
// filters and always returns an all-time mix), this API has no metaShare
// field, only numPlays (raw count) and a string-percentage winRate — see
// metaBadgeHtml() in js/decks.js for how that's rendered.
//
// Deliberately NOT passing consolidate=1: that flag merges every
// mechanically-equivalent "common" base (same color+type) into a single row
// under one arbitrary representative base name/image, which breaks the
// name-based matching in loadMetaArchetypes()/metaFor() (js/decks.js) for any
// deck whose actual base isn't that representative one — e.g. "Nevarro City,
// Restored" and "City in the Clouds" both silently disappeared into a
// "Shield Generator Complex" bucket under consolidate=1, showing no stats
// for real decks that do have data. consolidate=0 (the default) keeps one
// row per exact base, matching how local decks are keyed.
async function fetchArchetypesFromSwustats() {
  const data = await httpsGetJson(
    `https://swustats.net/TCGEngine/Stats/DeckMetaStatsAPI.php?startWeek=${ASH_START_WEEK}&format=Premier`
  );
  return Array.isArray(data) ? data : [];
}

// Per-card stats (win rate when included/played/resourced) from swustats.net's
// public Card Meta Stats API, scoped to the same ASH_START_WEEK season.
async function fetchCardStatsFromSwustats() {
  const data = await httpsGetJson(
    `https://swustats.net/TCGEngine/Stats/CardMetaStatsAPI.php?startWeek=${ASH_START_WEEK}`
  );
  return Array.isArray(data) ? data : [];
}

// The two sources are refreshed independently (allSettled, not all): a
// failure on one (e.g. swustats.net moving/breaking one endpoint) must not
// discard a successful result from the other.
async function refreshStats() {
  const [archetypesResult, cardsResult] = await Promise.allSettled([
    fetchArchetypesFromSwustats(),
    fetchCardStatsFromSwustats(),
  ]);
  if (archetypesResult.status === "fulfilled") statsCache.archetypes = archetypesResult.value;
  else console.error(`Could not refresh meta archetypes: ${archetypesResult.reason.message}`);
  if (cardsResult.status === "fulfilled") statsCache.cards = cardsResult.value;
  else console.error(`Could not refresh card stats: ${cardsResult.reason.message}`);
  statsCache.fetchedAt = Date.now();
  saveStatsFile(statsCache);
}

// Warm the cache from disk so a restart still serves last-known stats
// immediately, then kick off a background refresh right away and on a
// recurring timer (META_CACHE_MS) — fully async, independent of any request.
const persistedStats = loadStatsFile();
if (persistedStats) statsCache = persistedStats;
refreshStats();
setInterval(refreshStats, META_CACHE_MS);

// Deck price estimates (CardTrader). Two layers, both persisted so a restart
// doesn't refetch from scratch:
//  - cardTraderCatalog: set+number -> blueprint_id, near-static, rebuilt from
//    /expansions + /blueprints/export.
//  - priceIndex: set+number -> cheapest matching listing, refreshed more
//    often since actual prices move. Only cards actually used by a locally
//    synced deck are priced (not the whole SWU catalog), keeping the number
//    of /marketplace/products calls bounded by what's needed.
let cardTraderCatalog = { bySetNumber: {}, fetchedAt: 0 };
let priceIndex = { bySetNumber: {}, fetchedAt: 0 };

function loadCatalogFile() {
  try { return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")); }
  catch { return null; }
}
function saveCatalogFile(catalog) {
  fs.mkdirSync(path.dirname(CATALOG_FILE), { recursive: true });
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 1));
}
function loadPricesFile() {
  try { return JSON.parse(fs.readFileSync(PRICES_FILE, "utf8")); }
  catch { return null; }
}
function savePricesFile(prices) {
  fs.mkdirSync(path.dirname(PRICES_FILE), { recursive: true });
  fs.writeFileSync(PRICES_FILE, JSON.stringify(prices, null, 1));
}

// CardTrader is inconsistent about wrapping list responses: /games returns
// {array: [...]}, but /expansions, /categories and /blueprints/export return
// a bare JSON array. Handle both rather than assuming one shape.
function asArray(data) {
  if (Array.isArray(data)) return data;
  return (data && data.array) || [];
}

async function buildCardTraderCatalog() {
  const expansions = asArray(await cardTraderGetJson("/expansions"));
  const bySetNumber = {};
  for (const code of CARDTRADER_SET_CODES) {
    const expansion = expansions.find((e) => e.game_id === CARDTRADER_GAME_ID && e.code === code);
    if (!expansion) continue; // CardTrader hasn't listed this set yet (e.g. brand new)
    const blueprints = asArray(await cardTraderGetJson(`/blueprints/export?expansion_id=${expansion.id}`));
    for (const bp of blueprints) {
      if (bp.category_id !== CARDTRADER_SINGLES_CATEGORY_ID) continue; // skip sealed product
      const number = bp.fixed_properties && bp.fixed_properties.collector_number;
      if (!number) continue;
      bySetNumber[`${code}/${number}`] = { blueprintId: bp.id, name: bp.name };
    }
    await sleep(CARDTRADER_DELAY_MS);
  }
  cardTraderCatalog = { bySetNumber, fetchedAt: Date.now() };
  saveCatalogFile(cardTraderCatalog);
  return cardTraderCatalog;
}

async function getCardTraderCatalog() {
  const age = Date.now() - cardTraderCatalog.fetchedAt;
  if (cardTraderCatalog.fetchedAt && age < CATALOG_REFRESH_MS) return cardTraderCatalog;
  return buildCardTraderCatalog();
}

// Only the cheapest listing matching a "would actually buy this" profile
// counts: non-foil, not signed/altered, and in playable condition. Cheapest
// raw listing regardless of condition/language would understate the price
// with e.g. a heavily-played foreign copy nobody would build a deck out of.
const PRICE_ELIGIBLE_CONDITIONS = new Set(["Near Mint", "Slightly Played"]);

function pickCheapestEligibleCents(listings) {
  let best = null;
  for (const listing of listings || []) {
    const props = listing.properties_hash || {};
    if (props.starwars_foil || props.signed || props.altered) continue;
    if (!PRICE_ELIGIBLE_CONDITIONS.has(props.condition)) continue;
    if (listing.price_currency !== "EUR") continue;
    if (best === null || listing.price_cents < best) best = listing.price_cents;
  }
  return best;
}

async function fetchCardPriceCents(blueprintId) {
  const data = await cardTraderGetJson(`/marketplace/products?blueprint_id=${blueprintId}`);
  return pickCheapestEligibleCents(data[String(blueprintId)]);
}

// Every set+number actually played by at least one locally synced deck
// (leader, second leader, base, maindeck) — bounds price lookups to what's
// needed instead of pricing CardTrader's entire SWU catalog.
function collectUniqueCardRefs(decks) {
  const refs = new Map();
  const add = (ref) => {
    if (!ref || !ref.set || !ref.number) return;
    const key = `${ref.set.toLowerCase()}/${ref.number}`;
    if (!refs.has(key)) refs.set(key, ref);
  };
  for (const deck of Object.values(decks)) {
    add(normalizeRef(deck.leader));
    add(normalizeRef(deck.secondLeader));
    add(normalizeRef(deck.base));
    for (const c of deck.cards || []) add(c);
  }
  return refs;
}

async function refreshPrices() {
  if (!process.env.CARDTRADER_TOKEN) return;
  try {
    const catalog = await getCardTraderCatalog();
    const refs = collectUniqueCardRefs(loadDecks());
    const bySetNumber = { ...priceIndex.bySetNumber };
    for (const [key, ref] of refs) {
      const entry = catalog.bySetNumber[key];
      if (!entry) { bySetNumber[key] = null; continue; } // not in CardTrader's catalog
      try {
        const cents = await fetchCardPriceCents(entry.blueprintId);
        bySetNumber[key] = cents === null ? null : { cents, currency: "EUR" };
      } catch (err) {
        console.error(`Could not fetch price for ${key}: ${err.message}`);
      }
      await sleep(CARDTRADER_DELAY_MS);
    }
    priceIndex = { bySetNumber, fetchedAt: Date.now() };
    savePricesFile(priceIndex);
  } catch (err) {
    console.error(`Background price refresh failed: ${err.message}`);
  }
}

function priceForRef(ref) {
  if (!ref || !ref.set || !ref.number) return null;
  return priceIndex.bySetNumber[`${ref.set.toLowerCase()}/${ref.number}`] || null;
}

// Sums the cheapest-eligible price across leader+secondLeader+base+maindeck
// (weighted by copy count). `complete` is false if any card in the deck had
// no matching price, so the UI can flag the total as a lower-bound estimate
// rather than presenting it as exact.
function computeDeckPrice(deck) {
  const parts = [
    { ref: normalizeRef(deck.leader), count: 1 },
    { ref: normalizeRef(deck.secondLeader), count: 1 },
    { ref: normalizeRef(deck.base), count: 1 },
    ...(deck.cards || []).map((c) => ({ ref: c, count: c.count || 1 })),
  ].filter((p) => p.ref);
  if (!parts.length) return null;
  let totalCents = 0;
  let complete = true;
  let pricedCount = 0;
  for (const { ref, count } of parts) {
    const price = priceForRef(ref);
    if (price) {
      totalCents += price.cents * count;
      pricedCount++;
    } else {
      complete = false;
    }
  }
  if (!pricedCount) return null;
  return { cents: totalCents, currency: "EUR", complete };
}

const persistedCatalog = loadCatalogFile();
if (persistedCatalog) cardTraderCatalog = persistedCatalog;
const persistedPrices = loadPricesFile();
if (persistedPrices) priceIndex = persistedPrices;

if (process.env.CARDTRADER_TOKEN) {
  refreshPrices();
  setInterval(refreshPrices, PRICE_REFRESH_MS);
} else {
  console.log('CARDTRADER_TOKEN not set in .env — deck price estimates disabled.');
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
// Two independent passes — "hot" (trending) and "top" (swudb.com/decks/top,
// all-time most-liked) — merged into the same data/decks.json (deduped by
// deckId, same as re-running one sort twice). "top" skews toward
// older/deprecated-set decks but still contributes real card co-occurrence
// data for the deck-builder suggestions, which is why it's worth the extra
// calls even though those decks are less relevant for meta stats.
const SYNC_SORTS = ["hot", "top"];

async function syncDecks({ format, limit }) {
  if (syncInProgress) throw new Error("Un import est déjà en cours.");
  syncInProgress = true;
  syncProgress = { active: true, imported: 0, total: limit * SYNC_SORTS.length };
  try {
    const decks = loadDecks();
    let imported = 0;
    for (const sortby of SYNC_SORTS) {
      let skip = 0;
      let importedThisSort = 0;
      while (importedThisSort < limit) {
        const searchUrl = `https://swudb.com/api/decks/search?` +
          `skip=${skip}&sortby=${sortby}` + (format ? `&format=${encodeURIComponent(format)}` : "");
        const page = await httpsGetJson(searchUrl);
        const summaries = page.decks || [];
        if (!summaries.length) break;

        let i = 0;
        while (i < summaries.length && importedThisSort < limit) {
          const batch = summaries.slice(i, i + Math.min(SYNC_BATCH_SIZE, limit - importedThisSort));
          i += batch.length;
          const results = await Promise.allSettled(batch.map((summary) => syncOneDeck(decks, summary)));
          results.forEach((r, idx) => {
            if (r.status === "fulfilled") { imported++; importedThisSort++; }
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
    price: computeDeckPrice(deck),
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

// --- Deck builder: co-occurrence-based card suggestions ---
// No card-text/keyword analysis — suggestions are purely "which cards
// actually get played alongside this leader and/or these cards, across the
// decks we know about locally" (data/decks.json, populated by the "hot" +
// "top" sync above). Cheap, data-driven, and it naturally surfaces synergies
// like an upgrade-focused leader pulling in "Yellow Aces Bomber" without any
// hand-authored rule for it — at the cost of being blind to real synergies
// nobody has played yet, and only as good as the local deck sample size.
function cardKey(ref) {
  return `${(ref.name || "").toLowerCase()}|${(ref.title || "").toLowerCase()}`;
}

function listLeaders() {
  const decks = loadDecks();
  const byKey = new Map();
  for (const deck of Object.values(decks)) {
    const ref = normalizeRef(deck.leader);
    if (!ref || !ref.name) continue;
    const key = cardKey(ref);
    if (!byKey.has(key)) byKey.set(key, { ...ref, deckCount: 0 });
    byKey.get(key).deckCount++;
  }
  return [...byKey.values()].sort((a, b) => b.deckCount - a.deckCount);
}

function listCardNames() {
  const decks = Object.values(loadDecks());
  const names = new Set();
  for (const deck of decks) {
    for (const c of deck.cards || []) if (c.name) names.add(c.name);
  }
  return [...names].sort();
}

// Ranks every maindeck card (other than the ones already selected) by how
// often it co-occurs, among the locally known decks matching the chosen
// leader and/or already-selected cards. deckShare = fraction of those
// matching decks that play the card at least once.
function suggestCards({ leaderName, leaderTitle, cardNames }) {
  const decks = Object.values(loadDecks());
  const wantedCards = (cardNames || []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const excluded = new Set(wantedCards);

  const matching = decks.filter((deck) => {
    if (leaderName) {
      const ref = normalizeRef(deck.leader);
      if (!ref || !ref.name || ref.name.toLowerCase() !== leaderName.toLowerCase()) return false;
      if (leaderTitle && (ref.title || "").toLowerCase() !== leaderTitle.toLowerCase()) return false;
    }
    if (wantedCards.length) {
      const deckCardNames = new Set((deck.cards || []).map((c) => (c.name || "").toLowerCase()));
      if (!wantedCards.every((n) => deckCardNames.has(n))) return false;
    }
    return true;
  });

  const matchingDecks = matching.length;
  if (!matchingDecks) return { matchingDecks: 0, suggestions: [] };

  const tally = new Map(); // cardKey -> { ref, deckCount, totalCopies }
  for (const deck of matching) {
    const seenInThisDeck = new Set();
    for (const c of deck.cards || []) {
      if (!c.name || excluded.has(c.name.toLowerCase())) continue;
      const key = cardKey(c);
      if (!tally.has(key)) tally.set(key, { ref: c, deckCount: 0, totalCopies: 0 });
      const entry = tally.get(key);
      entry.totalCopies += c.count || 1;
      if (!seenInThisDeck.has(key)) {
        entry.deckCount++;
        seenInThisDeck.add(key);
      }
    }
  }

  const suggestions = [...tally.values()]
    .map((e) => ({
      name: e.ref.name,
      title: e.ref.title || "",
      set: e.ref.set || "",
      number: e.ref.number || "",
      deckCount: e.deckCount,
      deckShare: e.deckCount / matchingDecks,
      avgCopies: Math.round((e.totalCopies / e.deckCount) * 10) / 10,
    }))
    .sort((a, b) => b.deckShare - a.deckShare || b.deckCount - a.deckCount)
    .slice(0, 40);

  return { matchingDecks, suggestions };
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
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ archetypes: statsCache.archetypes, seasonStart: ASH_SEASON_START_ISO }));
    return;
  }

  if (url.pathname === "/api/cards/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ cards: statsCache.cards, seasonStart: ASH_SEASON_START_ISO }));
    return;
  }

  if (url.pathname === "/api/decks/by-card") {
    const q = url.searchParams.get("q") || "";
    const colors = (url.searchParams.get("colors") || "").split(",").filter(Boolean);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ decks: findDecksByCard(q, colors) }));
    return;
  }

  if (url.pathname === "/api/deckbuilder/leaders") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ leaders: listLeaders() }));
    return;
  }

  if (url.pathname === "/api/deckbuilder/cardnames") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ names: listCardNames() }));
    return;
  }

  if (url.pathname === "/api/deckbuilder/suggest") {
    const leaderName = url.searchParams.get("leaderName") || "";
    const leaderTitle = url.searchParams.get("leaderTitle") || "";
    const cardNames = (url.searchParams.get("cards") || "").split(",").map((s) => s.trim()).filter(Boolean);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(suggestCards({ leaderName, leaderTitle, cardNames })));
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
