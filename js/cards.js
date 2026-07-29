// Onglet "Recherche de cartes". Ce fichier ne touche qu'à cet onglet : son
// initFn (appelée par js/common.js une fois partials/cards.html injecté) est
// le seul point d'entrée qui a le droit de toucher le DOM avant que le
// partial existe.
const API = "/api/cards/search";
let resultsEl, statusEl;

function buildQuery(){
  const raw = $("#q").value.trim();
  if (raw.startsWith("raw:")) return raw.slice(4).trim();

  const parts = [];
  if (raw) {
    const term = raw.replace(/"/g,'');
    parts.push(`(t:"${term}" OR "${term}")`);
  }
  const set = $("#set").value;
  if (set) parts.push(`set:${set}`);
  const type = $("#type").value;
  if (type) parts.push(`ty:${type}`);
  const aspect = $("#aspect").value;
  if (aspect) parts.push(`a:${aspect}`);
  const arena = $("#arena").value;
  if (arena) parts.push(`ar:${arena}`);
  return parts.join(" AND ");
}

function setAspect(value){
  $("#aspect").value = value;
  document.querySelectorAll("#aspectPicker button").forEach((b) => {
    b.classList.toggle("selected", b.dataset.value === value);
  });
}

// Filtres rapides par type/arène. Le Set choisi (ASH par défaut) n'est pas
// touché : ces boutons filtrent dans le contexte déjà sélectionné plutôt que
// de le réinitialiser.
const PRESETS = {
  "leader": () => { $("#q").value = ""; $("#type").value = "leader"; $("#arena").value = ""; setAspect(""); },
  "ground": () => { $("#q").value = ""; $("#type").value = "unit"; $("#arena").value = "ground"; setAspect(""); },
  "space": () => { $("#q").value = ""; $("#type").value = "unit"; $("#arena").value = "space"; setAspect(""); },
  "upgrade": () => { $("#q").value = ""; $("#type").value = "upgrade"; $("#arena").value = ""; setAspect(""); },
  "event": () => { $("#q").value = ""; $("#type").value = "event"; $("#arena").value = ""; setAspect(""); },
};

function pick(obj, patterns){
  const keys = Object.keys(obj || {});
  for (const p of patterns){
    const hit = keys.find(k => k.toLowerCase() === p.toLowerCase());
    if (hit && obj[hit] !== undefined && obj[hit] !== null && obj[hit] !== "") return obj[hit];
  }
  for (const p of patterns){
    const hit = keys.find(k => k.toLowerCase().includes(p.toLowerCase()));
    if (hit && obj[hit] !== undefined && obj[hit] !== null && obj[hit] !== "") return obj[hit];
  }
  return undefined;
}

function findImage(card){
  const keys = Object.keys(card || {});
  for (const k of keys){
    const v = card[k];
    if (typeof v === "string" && /^https?:\/\//.test(v) && /(art|image|img|url)/i.test(k)) return v;
  }
  // nested front/back objects sometimes hold art urls
  for (const k of keys){
    const v = card[k];
    if (v && typeof v === "object" && !Array.isArray(v)){
      const nested = findImage(v);
      if (nested) return nested;
    }
  }
  return null;
}

function extractArray(data){
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const k of ["Data","data","Cards","cards","results","Results","items","Items"]){
    if (Array.isArray(data[k])) return data[k];
  }
  for (const k of Object.keys(data)){
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

// Per-card win-rate stats via swustats.net's Card Meta Stats API, scoped to
// the ASH season (see server.js's ASH_START_WEEK), loaded once. Unique cards
// (leaders/bases) are keyed "Name, Subtitle"; non-unique cards presumably by
// plain Name (unverified — falls back gracefully, no match = no badge, same
// pattern as metaFor() in js/decks.js).
let cardStatsIndex = new Map();
async function loadCardStats(){
  try {
    const res = await fetch("/api/cards/stats");
    const data = await res.json();
    for (const c of data.cards || []) cardStatsIndex.set((c.cardName || "").toLowerCase(), c);
    if (data.seasonStart) {
      window.SWU.statsSeasonStart = data.seasonStart;
      const el = document.getElementById("cardStatsSeasonLabel");
      if (el) el.textContent = `saison Ashes of the Empire (${window.SWU.seasonPeriodLabel()})`;
    }
  } catch { /* pas grave, on affichera juste sans stats carte */ }
}

function cardStatsFor(card){
  const name = pick(card, ["Name","name"]) || "";
  const subtitle = pick(card, ["Subtitle","subtitle"]) || "";
  if (subtitle) {
    const uniqueKey = `${name}, ${subtitle}`.toLowerCase();
    if (cardStatsIndex.has(uniqueKey)) return cardStatsIndex.get(uniqueKey);
  }
  return cardStatsIndex.get(name.toLowerCase()) || null;
}

function cardStatsBadgeHtml(card){
  const stats = cardStatsFor(card);
  if (!stats) return "";
  const winIncl = parseFloat(stats.percentIncludedInWins).toFixed(1);
  const winPlayed = parseFloat(stats.percentPlayedInWins).toFixed(1);
  return `<span class="badge cardstats-badge" title="Données swustats.net, saison Ashes of the Empire ${window.SWU.seasonPeriodLabel()}">🎯 ${winIncl}% winrate (inclus) · ${winPlayed}% winrate (jouée) · ${stats.timesIncluded} decks</span>`;
}

function highlight(text, term){
  if (!text) return "";
  if (!term) return text;
  try{
    const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, "ig");
    return text.replace(re, "<mark>$1</mark>");
  }catch{ return text; }
}

async function search(){
  const query = buildQuery();
  const termForHighlight = $("#q").value.trim().replace(/^raw:/,'');
  resultsEl.innerHTML = "";
  if (!query){
    statusEl.className = "status";
    statusEl.textContent = "Saisis un texte ou choisis un filtre (set / type / aspect) avant de rechercher.";
    return;
  }
  statusEl.className = "status";
  statusEl.textContent = `Recherche en cours… (q=${query})`;

  const url = `${API}?q=${encodeURIComponent(query)}&format=json`;
  try{
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cards = extractArray(data);
    if (!cards.length){
      statusEl.textContent = "Aucune carte trouvée pour cette recherche.";
      return;
    }
    statusEl.textContent = `${cards.length} carte(s) trouvée(s) — q=${query}`;
    render(cards, termForHighlight);
  }catch(err){
    statusEl.className = "status err";
    statusEl.textContent = `Erreur de requête vers l'API (${err.message}). ` +
      `Cette page doit être servie par "node server.js" (voir README) : l'API api.swu-db.com ` +
      `ne renvoie pas d'en-tête CORS sur ses réponses, donc un fetch() direct depuis le navigateur ` +
      `est bloqué quelle que soit la façon dont ce fichier est ouvert.`;
  }
}

function render(cards, term){
  resultsEl.innerHTML = "";
  for (const card of cards){
    const name = pick(card, ["Name","name"]) || "?";
    const subtitle = pick(card, ["Subtitle","subtitle"]) || "";
    const set = pick(card, ["Set","set"]) || "";
    const number = pick(card, ["Number","number","CardNumber"]) || "";
    const type = pick(card, ["Type","type"]) || "";
    const cost = pick(card, ["Cost","cost"]);
    const power = pick(card, ["Power","power"]);
    const hp = pick(card, ["HP","Hp","hp"]);
    const aspects = pick(card, ["Aspects","aspects"]);
    const text = pick(card, ["FrontText","Text","text","Rules","OracleText"]) || "";
    const img = findImage(card);

    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="art">${img ? `<img loading="lazy" src="${img}" alt="${name}">` : `<div class="noimg">Pas d'image<br>disponible</div>`}</div>
      <div class="body">
        <div class="name">${highlight(String(name), term)}</div>
        ${subtitle ? `<div class="sub">${highlight(String(subtitle), term)}</div>` : ""}
        <div class="badges">
          ${set ? `<span class="badge">${String(set).toUpperCase()} ${number}</span>` : ""}
          ${type ? `<span class="badge">${type}</span>` : ""}
          ${cost !== undefined ? `<span class="badge">Coût ${cost}</span>` : ""}
          ${power !== undefined ? `<span class="badge">PWR ${power}</span>` : ""}
          ${hp !== undefined ? `<span class="badge">HP ${hp}</span>` : ""}
          ${Array.isArray(aspects) ? aspects.map(a=>`<span class="badge">${a}</span>`).join("") : (aspects ? `<span class="badge">${aspects}</span>` : "")}
          ${cardStatsBadgeHtml(card)}
        </div>
        ${text ? `<div class="cardtext">${highlight(String(text), term)}</div>` : ""}
        <div class="links">
          ${set && number ? `<a href="https://swudb.com/card/${String(set).toUpperCase()}/${number}" target="_blank" rel="noopener">Carte ↗</a>` : ""}
        </div>
        <details>
          <summary>JSON brut</summary>
          <pre>${JSON.stringify(card, null, 1)}</pre>
        </details>
      </div>
    `;
    resultsEl.appendChild(el);
  }
}

window.SWU_TABS.cards = function initCardsTab(){
  resultsEl = $("#results");
  statusEl = $("#status");

  window.SWU.fillSetOptions($("#set"), "ash");

  document.querySelectorAll("#aspectPicker button").forEach((btn) => {
    btn.addEventListener("click", () => setAspect(btn.dataset.value));
  });
  document.querySelectorAll("[data-preset]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ PRESETS[btn.dataset.preset](); search(); });
  });
  $("#go").addEventListener("click", search);
  $("#q").addEventListener("keydown", (e)=>{ if(e.key==="Enter") search(); });

  loadCardStats();
};
