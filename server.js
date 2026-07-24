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
const STATS_FILE = path.join(ROOT, "data", "stats.json");
const SYNC_DELAY_MS = 200;
const META_CACHE_MS = 60 * 60 * 1000;

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

// --- Galactic Championship tracker (melee.gg) --------------------------------
// melee.gg has no documented public API and (like api.swu-db.com) no CORS
// headers, so this needs the same server-side relay treatment. On top of
// that it fronts everything with a WAF that 403s requests missing a
// plausible browser Referer, and — confirmed by hand while building this —
// temporarily blocks the calling IP outright after a handful of requests in
// quick succession. So this polls far more conservatively than the swudb.com
// deck sync above: one request in flight at a time, a real delay between
// each, registration-phase tournaments are skipped after a single cheap
// status check, and a failed poll cycle just waits for the next one instead
// of retrying — better to under-refresh than to get the user's own IP
// blocked from watching the tournament live in their browser.
const MELEE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MELEE_REFERER = "https://melee.gg/Hub/View/37072";
const MELEE_HUB_ID = 37072;
const MELEE_TOURNAMENTS = [
  { id: 403891, label: "Last Chance Qualifier" },
  { id: 403893, label: "Main Event" },
  { id: 403894, label: "Galactic Open Premier" },
  { id: 404187, label: "Galactic Open Eternal (Red)" },
  { id: 412104, label: "Galactic Open Eternal (Blue)" },
];
// The third player's exact spelling wasn't certain ("Malette" vs "Malete")
// at the time this was written — matched as a case-insensitive substring
// against both username and display name so either spelling still hits.
const MELEE_TRACKED_PLAYERS = ["Fred57155", "Pecoraban", "Malet"];
const GALACTIC_FILE = path.join(ROOT, "data", "galactic.json");
const GALACTIC_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MELEE_REQUEST_DELAY_MS = 1500;

function httpsRequest(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function meleeHeaders(extra) {
  return { "user-agent": MELEE_UA, referer: MELEE_REFERER, ...extra };
}

async function meleeGetHtml(pathAndQuery) {
  const { status, body } = await httpsRequest(`https://melee.gg${pathAndQuery}`, { headers: meleeHeaders({}) });
  if (status !== 200) throw new Error(`melee.gg GET ${pathAndQuery} -> HTTP ${status}`);
  return body;
}

async function meleePostForm(pathName, fields) {
  const body = new URLSearchParams(fields).toString();
  const { status, body: respBody } = await httpsRequest(`https://melee.gg${pathName}`, {
    method: "POST",
    headers: meleeHeaders({
      "x-requested-with": "XMLHttpRequest",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "content-length": Buffer.byteLength(body),
    }),
    body,
  });
  if (status !== 200) throw new Error(`melee.gg POST ${pathName} -> HTTP ${status}`);
  return JSON.parse(respBody);
}

// melee.gg's tables are server-side DataTables endpoints: every request
// carries the full DataTables column/order/search envelope even though we
// only ever want page 1 sorted by the default column.
function dataTablesColumnFields(columns) {
  const fields = {};
  columns.forEach((c, idx) => {
    fields[`columns[${idx}][data]`] = c;
    fields[`columns[${idx}][name]`] = "";
    fields[`columns[${idx}][searchable]`] = "true";
    fields[`columns[${idx}][orderable]`] = "true";
    fields[`columns[${idx}][search][value]`] = "";
    fields[`columns[${idx}][search][regex]`] = "false";
  });
  return fields;
}

function dataTablesEnvelope(extra) {
  return {
    draw: "1", start: "0",
    "search[value]": "", "search[regex]": "false",
    "order[0][column]": "0", "order[0][dir]": "asc",
    ...extra,
  };
}

async function meleeGetHubTournaments() {
  const fields = dataTablesEnvelope({
    length: "50",
    ...dataTablesColumnFields(["StartDate", "ID", "Name", "Game", "Status"]),
  });
  const data = await meleePostForm(`/Hub/SearchTournaments/${MELEE_HUB_ID}`, fields);
  return data.data || [];
}

// Round IDs aren't exposed by any JSON endpoint — they only show up as
// data-id attributes on the round-selector buttons rendered into the
// tournament's own HTML page, and only once the tournament has actually
// started (a tournament still in "Registration" renders no round selectors
// at all). Standings buttons carry data-is-completed, pairings buttons carry
// data-is-started — same round list, different "is this one ready" flag.
function extractRoundSelectors(html, flagAttr) {
  const re = new RegExp(`round-selector"[^>]*data-id="(\\d+)"[^>]*data-name="([^"]+)"[^>]*data-${flagAttr}="(True|False)"`, "g");
  const rounds = [];
  let m;
  while ((m = re.exec(html))) rounds.push({ id: m[1], name: m[2], flag: m[3] === "True" });
  return rounds;
}

function lastFlagged(rounds) {
  const flagged = rounds.filter((r) => r.flag);
  return flagged.length ? flagged[flagged.length - 1] : null;
}

async function meleeGetTournamentRounds(tournamentId) {
  const html = await meleeGetHtml(`/Tournament/View/${tournamentId}`);
  return {
    standingsRounds: extractRoundSelectors(html, "is-completed"),
    pairingsRounds: extractRoundSelectors(html, "is-started"),
  };
}

async function meleeGetRoundStandings(roundId, length) {
  const fields = dataTablesEnvelope({
    length: String(length),
    roundId: String(roundId),
    ...dataTablesColumnFields(["Rank", "Player", "Decklists", "MatchRecord", "GameRecord", "Points", "OpponentCount"]),
  });
  const data = await meleePostForm(`/Standing/GetRoundStandings/${roundId}`, fields);
  return data.data || [];
}

async function meleeGetRoundMatches(roundId, length) {
  const fields = dataTablesEnvelope({
    length: String(length),
    ...dataTablesColumnFields(["TableNumber", "PodNumber", "Teams", "Decklists", "ResultString"]),
  });
  const data = await meleePostForm(`/Match/GetRoundMatches/${roundId}`, fields);
  return data.data || [];
}

function matchesTrackedPlayer(needle, username, displayName) {
  return (username || "").toLowerCase().includes(needle) || (displayName || "").toLowerCase().includes(needle);
}

function findTrackedInStandings(rows) {
  const found = {};
  for (const row of rows) {
    for (const player of (row.Team && row.Team.Players) || []) {
      for (const tracked of MELEE_TRACKED_PLAYERS) {
        if (matchesTrackedPlayer(tracked.toLowerCase(), player.Username, player.DisplayName)) {
          found[tracked] = {
            username: player.Username,
            displayName: player.DisplayName,
            rank: row.Rank,
            matchRecord: row.MatchRecord,
            gameRecord: row.GameRecord,
            points: row.Points,
            roundName: row.Round,
          };
        }
      }
    }
  }
  return found;
}

// The exact shape of a match row's "Teams" field wasn't verified live (the
// tracked API got IP-blocked mid-investigation before this could be tested
// against an in-progress round) — this defensively accepts either
// Teams[].Players or Teams[].Team.Players so it degrades gracefully instead
// of throwing if the real shape turns out to be the nested one.
function teamPlayers(team) {
  return team.Players || (team.Team && team.Team.Players) || [];
}

function findTrackedInMatches(rows) {
  const found = {};
  for (const row of rows) {
    const teams = row.Teams || [];
    for (const team of teams) {
      for (const player of teamPlayers(team)) {
        for (const tracked of MELEE_TRACKED_PLAYERS) {
          if (matchesTrackedPlayer(tracked.toLowerCase(), player.Username, player.DisplayName)) {
            const opponents = teams.filter((t) => t !== team)
              .flatMap((t) => teamPlayers(t).map((p) => p.DisplayName || p.Username));
            found[tracked] = { table: row.TableNumberDescription || row.TableNumber, opponents, result: row.ResultString };
          }
        }
      }
    }
  }
  return found;
}

function loadGalactic() {
  try { return JSON.parse(fs.readFileSync(GALACTIC_FILE, "utf8")); }
  catch { return { lastPolled: null, lastError: null, trackedPlayers: MELEE_TRACKED_PLAYERS, tournaments: {} }; }
}

function saveGalactic(state) {
  fs.mkdirSync(path.dirname(GALACTIC_FILE), { recursive: true });
  fs.writeFileSync(GALACTIC_FILE, JSON.stringify(state, null, 1));
}

let galacticPollInProgress = false;

async function pollGalacticOnce() {
  if (galacticPollInProgress) return;
  galacticPollInProgress = true;
  const state = loadGalactic();
  state.trackedPlayers = MELEE_TRACKED_PLAYERS;
  try {
    const summaries = await meleeGetHubTournaments();
    await sleep(MELEE_REQUEST_DELAY_MS);
    const summaryById = Object.fromEntries(summaries.map((t) => [t.ID, t]));

    for (const { id, label } of MELEE_TOURNAMENTS) {
      const summary = summaryById[id];
      const previous = state.tournaments[id] || {};
      const entry = {
        id, label,
        name: summary ? summary.Name : label,
        statusDescription: summary ? summary.StatusDescription : "Inconnu",
        playerCount: summary ? summary.ParticipatingCount : null,
        players: previous.players || {},
      };

      if (!summary || summary.StatusDescription === "Registration") {
        entry.status = "not_started";
        state.tournaments[id] = entry;
        continue;
      }

      try {
        const { standingsRounds, pairingsRounds } = await meleeGetTournamentRounds(id);
        await sleep(MELEE_REQUEST_DELAY_MS);
        const length = Math.min(Math.max(summary.ParticipatingCount || 0, 100), 2500);

        const standingRound = lastFlagged(standingsRounds);
        if (standingRound) {
          const rows = await meleeGetRoundStandings(standingRound.id, length);
          await sleep(MELEE_REQUEST_DELAY_MS);
          const found = findTrackedInStandings(rows);
          for (const [name, info] of Object.entries(found)) {
            entry.players[name] = { ...(entry.players[name] || {}), standing: info };
          }
        }

        const pairingRound = lastFlagged(pairingsRounds);
        if (pairingRound) {
          const rows = await meleeGetRoundMatches(pairingRound.id, length);
          await sleep(MELEE_REQUEST_DELAY_MS);
          const found = findTrackedInMatches(rows);
          for (const [name, info] of Object.entries(found)) {
            entry.players[name] = { ...(entry.players[name] || {}), pairing: { roundName: pairingRound.name, ...info } };
          }
        }

        entry.status = "started";
      } catch (err) {
        entry.status = "error";
        entry.error = err.message;
      }

      state.tournaments[id] = entry;
    }

    state.lastPolled = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message;
  } finally {
    saveGalactic(state);
    galacticPollInProgress = false;
  }
}

function scheduleGalacticPolling() {
  if (!MELEE_TRACKED_PLAYERS.length) return;
  const runAndLog = () => pollGalacticOnce().catch((err) => console.error("Galactic poll failed:", err.message));
  runAndLog();
  setInterval(runAndLog, GALACTIC_POLL_INTERVAL_MS);
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

// Meta/card stats (swustats.net) are synced independently from the deck
// import button: they run on their own recurring background timer and
// persist to data/stats.json, decoupled from data/decks.json's manual sync.
// Requests just read the in-memory cache — no per-request network fetch,
// no coupling to the "Importer" click.
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

const SYNC_BATCH_SIZE = 5;
let syncProgress = { active: false, imported: 0, total: 0 };

// Decks whose leader or base is from a deprecated set (no longer
// legal/played) just add clutter to the local base without being useful —
// skip saving them rather than expose a "hide these" filter in the UI.
// syncOneDeck() returns false for a skip so syncDecks() knows not to count it
// toward the requested limit (it'll fetch further pages to make up the
// difference instead). Only leader/base are checked (not every maindeck
// card): those two are the deck-defining singleton slots, and a deck built
// around a current leader can still legitimately run an older-set base (or
// vice versa) without the whole deck being "from" a deprecated set.
const DEPRECATED_SETS = new Set(["SOR", "SHD", "TWI"]);
const isDeprecatedRef = (ref) => !!ref && DEPRECATED_SETS.has((ref.set || "").toUpperCase());

async function syncOneDeck(decks, summary) {
  const deck = await httpsGetJson(`https://swudb.com/api/deck/${summary.deckId}`);
  const leaderRef = cardRef(deck.leader);
  const baseRef = cardRef(deck.base);
  if (isDeprecatedRef(leaderRef) || isDeprecatedRef(baseRef)) return false;
  const secondLeaderRef = cardRef(deck.secondLeader);
  const cards = (deck.shuffledDeck || []).map((entry) => ({
    ...cardRef(entry.card),
    count: entry.count,
  }));
  const [leaderAspects, secondLeaderAspects, baseAspects] = await Promise.all([
    resolveAspects(leaderRef), resolveAspects(secondLeaderRef), resolveAspects(baseRef),
  ]);
  const manaCurve = computeManaCurve(deck.shuffledDeck);
  // swudb.com's own deck-detail response already includes a TCGPlayer-sourced
  // price estimate (USD) — free with the same call syncOneDeck() already
  // makes, no separate pricing integration needed.
  const price = deck.priceDetail
    ? { low: deck.priceDetail.lowPrice, market: deck.priceDetail.marketPrice, currency: "USD" }
    : null;
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
    price,
  };
  return true;
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
            if (r.status === "fulfilled") {
              if (r.value) { imported++; importedThisSort++; } // false = deprecated-leader skip, not an error
            } else {
              console.error(`Skipping deck ${batch[idx].deckId}: ${r.reason.message}`);
            }
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
    price: deck.price || null,
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

function listBases() {
  const decks = loadDecks();
  const byKey = new Map();
  for (const deck of Object.values(decks)) {
    const ref = normalizeRef(deck.base);
    if (!ref || !ref.name) continue;
    const key = cardKey(ref);
    if (!byKey.has(key)) byKey.set(key, { ...ref, deckCount: 0 });
    byKey.get(key).deckCount++;
  }
  return [...byKey.values()].sort((a, b) => b.deckCount - a.deckCount);
}

// One ref per distinct card name (first printing seen — good enough to
// identify the card for a set:number-based export; a deck rarely mixes
// multiple printings of the same card anyway). Set+number is what
// js/deckbuilder.js needs to build a swudb.com-importable JSON id
// ("SET_NUMBER") for cards added via the free-text/datalist input, which
// otherwise only carries a name.
function listCardRefs() {
  const decks = Object.values(loadDecks());
  const byName = new Map();
  for (const deck of decks) {
    for (const c of deck.cards || []) {
      if (c.name && !byName.has(c.name)) byName.set(c.name, { name: c.name, set: c.set || "", number: c.number || "" });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
    res.end(JSON.stringify({ count, lastSyncedAt }));
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

  if (url.pathname === "/api/deckbuilder/bases") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ bases: listBases() }));
    return;
  }

  if (url.pathname === "/api/deckbuilder/cardnames") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ cards: listCardRefs() }));
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

  if (url.pathname === "/api/galactic/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(loadGalactic()));
    return;
  }

  if (url.pathname === "/api/galactic/refresh" && req.method === "POST") {
    if (galacticPollInProgress) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Une actualisation melee.gg est déjà en cours." }));
      return;
    }
    pollGalacticOnce()
      .then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(loadGalactic()));
      })
      .catch((err) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
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
  scheduleGalacticPolling();
});
