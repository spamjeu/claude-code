// Onglet "Base de decks". Ce fichier ne touche qu'à cet onglet (+ l'overlay
// #cardPreview, qui vit dans le shell index.html mais n'est utilisé que par
// les survols de cartes de cette base de decks).
let deckSyncBtn, deckClearBtn, deckSyncStatus, deckCardQ, deckSearchBtn, deckSearchStatus,
  deckResultsEl, deckSortSel, deckGroupSel, deckDbStatusEl, deckPeriodSel, deckFromEl, deckToEl;
let lastDeckResults = [];

// Presence méta (Premier) via l'API publique de swustats.net, scopée à la
// saison ASH côté serveur (voir ASH_START_WEEK dans server.js), chargée une
// fois et indexée par "Leader | Titre" + nom de base pour un lookup O(1) au
// rendu de chaque deck. Note : les champs de swustats.net sont inversés par
// rapport aux nôtres — leaderTitle/baseTitle = le nom du perso/de la base,
// leaderSubtitle = le sous-titre SWU. Silencieux si pas de correspondance
// (ex: leaders/bases pas encore assez joués pour être trackés, ou base
// générique).
let metaArchetypeIndex = new Map();
async function loadMetaArchetypes(){
  try {
    const res = await fetch("/api/meta/archetypes");
    const data = await res.json();
    for (const a of data.archetypes || []) {
      const key = `${a.leaderTitle}${a.leaderSubtitle ? " | " + a.leaderSubtitle : ""}||${a.baseTitle}`;
      // Clé en minuscules : swustats.net et swudb.com ne sont pas toujours
      // d'accord sur la casse d'un même nom (ex: "Still Faster than You" vs
      // "Still Faster Than You"), ce qui ferait échouer silencieusement un
      // match sensible à la casse.
      metaArchetypeIndex.set(key.toLowerCase(), a);
    }
    if (data.seasonStart) {
      window.SWU.statsSeasonStart = data.seasonStart;
      const el = document.getElementById("deckStatsSeasonLabel");
      if (el) el.textContent = `Ashes of the Empire (${window.SWU.seasonPeriodLabel()})`;
    }
  } catch { /* pas grave, on affichera juste sans stats méta */ }
}
function metaFor(d){
  if (!d.leaderName) return null;
  // swustats.net folds a base's subtitle into baseTitle as "Nom, Sous-titre"
  // (unlike leaders, where subtitle is a separate field) — reproduce that
  // here so named bases like "Nevarro City, Restored" actually match instead
  // of silently missing.
  const base = `${d.baseName || ""}${d.baseTitle ? ", " + d.baseTitle : ""}`;
  const key = `${d.leaderName}${d.leaderTitle ? " | " + d.leaderTitle : ""}||${base}`;
  return metaArchetypeIndex.get(key.toLowerCase()) || null;
}

async function refreshDeckDbStatus(){
  try {
    const res = await fetch("/api/decks/status");
    const data = await res.json();
    if (!data.count) {
      deckDbStatusEl.textContent = "Base locale vide — aucune synchro effectuée.";
    } else {
      const date = new Date(data.lastSyncedAt);
      deckDbStatusEl.textContent = `${data.count} deck(s) en base — dernière synchro : ${date.toLocaleString("fr-FR")}`;
    }
  } catch {
    deckDbStatusEl.textContent = "";
  }
}

function sortDecks(decks){
  const sorted = [...decks];
  if (deckSortSel.value === "leader") {
    sorted.sort((a, b) => (a.leaderName || "").localeCompare(b.leaderName || ""));
  } else if (deckSortSel.value === "date") {
    // publishDate est en ISO UTC : l'ordre lexicographique EST l'ordre chronologique.
    sorted.sort((a, b) => String(b.publishDate || "").localeCompare(String(a.publishDate || "")));
  } else {
    sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  }
  return sorted;
}

// "2026-07-06T19:09:09.9Z" -> "06/07/2026". On coupe à la journée avant de
// construire la Date : sans ça un deck publié en soirée UTC s'affiche la veille
// (ou le lendemain) selon le fuseau du navigateur.
function fmtPublishDate(iso){
  if (!iso) return "";
  return window.SWU.formatFrDate(String(iso).slice(0, 10));
}

// Les bornes envoyées au serveur ("YYYY-MM-DD", telles que les rend <input
// type="date">, donc rien à reformater).
function selectedDeckDates(){
  return { from: deckFromEl.value, to: deckToEl.value };
}

function isoDaysAgo(days){
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Les raccourcis ne font que remplir les deux champs : le filtre lui-même ne
// lit jamais que ces champs, donc "personnalisé" n'est pas un mode à part —
// c'est juste l'étiquette quand les dates ne correspondent à aucun raccourci.
function applyDeckPeriodPreset(){
  const value = deckPeriodSel.value;
  if (value === "custom") return;
  const today = new Date().toISOString().slice(0, 10);
  if (value === "all") {
    deckFromEl.value = "";
    deckToEl.value = "";
  } else if (value === "season") {
    deckFromEl.value = window.SWU.statsSeasonStart || "2026-07-11";
    deckToEl.value = today;
  } else {
    deckFromEl.value = isoDaysAgo(Number(value));
    deckToEl.value = today;
  }
}

function colorDots(colors){
  if (!colors || !colors.length) return "";
  return colors.map((c) => `<img class="aspect-icon-sm" src="assets/aspects/${c.toLowerCase()}.png" alt="${c}" title="${c}" />`).join("");
}

// Leaders and bases are landscape cards (unlike units/upgrades/events, which
// are portrait) — flagged here so the hover preview can resize itself
// instead of squashing/cropping a landscape image into a portrait box.
function previewAttrs(set, number, landscape){
  if (!set || !number) return "";
  return `data-preview-set="${set}" data-preview-number="${number}"${landscape ? ' data-preview-landscape="1"' : ""}`;
}

function manaCurveHtml(curve){
  if (!curve || !curve.some((n) => n > 0)) return "";
  const shown = curve.slice(1); // le coût 0 est quasi toujours vide, pas utile à afficher
  const max = Math.max(...shown);
  const bars = shown.map((n, i) => {
    const cost = i + 1;
    return `
    <div class="manacurve-col" title="${n} carte(s) à coût ${cost === 6 ? "6+" : cost}">
      <div class="manacurve-bar" style="height:${max ? Math.max(3, Math.round((n / max) * 28)) : 3}px"></div>
      <div class="manacurve-label">${cost === 6 ? "6+" : cost}</div>
    </div>`;
  }).join("");
  return `<div class="manacurve" title="Courbe de mana">${bars}</div>`;
}

function metaBadgeHtml(d){
  const meta = metaFor(d);
  if (!meta) return "";
  const winRate = parseFloat(meta.winRate).toFixed(1);
  const plays = meta.numPlays ?? 0;
  return `<span class="badge meta-badge" title="Données swustats.net, saison Ashes of the Empire ${window.SWU.seasonPeriodLabel()}, format Premier">📊 ${winRate}% winrate (${plays} parties, ASH)</span>`;
}

function priceHtml(d){
  if (!d.price) return `<span class="muted">—</span>`;
  const market = d.price.market.toFixed(2).replace(".", ",");
  const low = d.price.low.toFixed(2).replace(".", ",");
  const title = `Prix indicatif via TCGPlayer (source : swudb.com, en dollars, pas de calcul local) — prix bas : ${low} $ · prix marché : ${market} $.`;
  return `<span title="${title}">${market} $</span>`;
}

function deckRowHtml(d){
  const matchesRow = d.matches.length ? `
    <tr class="deckrow-matches">
      <td colspan="7">
        <div class="badges-wrap">
          ${d.matches.map((m) => `<span class="badge" ${previewAttrs(m.set, m.number, m.role !== "Deck")}>${m.role}${m.count !== undefined ? `: ${m.count}x` : ""} ${m.name}${m.title ? " — " + m.title : ""} (${m.set || "?"}/${m.number || "?"})</span>`).join("")}
        </div>
      </td>
    </tr>` : "";
  return `
    <tr class="deckrow">
      <td class="col-likes">❤️ ${d.likeCount || 0}</td>
      <td class="col-aspects">${colorDots(d.colors)}</td>
      <td class="col-deck">
        <div class="deck-name-line"><a href="https://swudb.com/deck/${d.deckId}" target="_blank" rel="noopener">${d.deckName}</a> <span class="muted">par ${d.authorName}</span></div>
        <div class="deck-leader-line"><span ${previewAttrs(d.leaderSet, d.leaderNumber, true)}>${d.leaderName || "?"}</span>${d.baseName ? ` / <span ${previewAttrs(d.baseSet, d.baseNumber, true)}>${d.baseName}</span>` : ""}</div>
      </td>
      <td class="col-date">${fmtPublishDate(d.publishDate) || `<span class="muted">—</span>`}</td>
      <td class="col-curve">${manaCurveHtml(d.manaCurve)}</td>
      <td class="col-winrate">${metaBadgeHtml(d) || `<span class="muted">—</span>`}</td>
      <td class="col-price">${priceHtml(d)}</td>
    </tr>
    ${matchesRow}
  `;
}

function groupKeyFor(d){
  if (deckGroupSel.value === "leader") {
    const colors = [...(d.colors || [])].sort().join("/") || "Sans couleur";
    return { key: `${colors}__${d.leaderName || "?"}`, label: `${colorDots(d.colors)} ${d.leaderName || "Leader inconnu"}` };
  }
  if (deckGroupSel.value === "set") {
    const set = d.leaderSet || "?";
    return { key: set, label: `Extension ${set}` };
  }
  return null;
}

const DECKTABLE_HEAD = `
  <thead><tr>
    <th>❤️</th><th>Couleurs</th><th>Deck</th><th>Publié</th><th>Courbe de mana</th><th>Winrate (ASH, Premier)</th><th>Prix (TCGPlayer)</th>
  </tr></thead>`;

// Clé de groupe -> replié ou non. Survit aux re-rendus (tri, ajout de decks
// pendant un sync) tant que le regroupement choisi ne change pas, pour que
// cliquer "réduire" sur un gros groupe (ex: beaucoup de decks JTL) ne se
// réinitialise pas à chaque petit rafraîchissement.
let collapsedGroups = new Set();
let lastGroupKeys = [];

function renderDeckResults(decks){
  const sorted = sortDecks(decks);
  if (deckGroupSel.value === "none") {
    deckResultsEl.innerHTML = `<div class="decklist-wrap"><table class="decktable">${DECKTABLE_HEAD}
      <tbody>${sorted.map(deckRowHtml).join("")}</tbody></table></div>`;
    return;
  }
  const groups = new Map();
  for (const d of sorted) {
    const { key, label } = groupKeyFor(d);
    if (!groups.has(key)) groups.set(key, { label, decks: [] });
    groups.get(key).decks.push(d);
  }
  const entries = [...groups.entries()];
  lastGroupKeys = entries.map(([key]) => key);
  deckResultsEl.innerHTML = entries.map(([key, g], i) => {
    const collapsed = collapsedGroups.has(key);
    return `
    <div class="deckgroup${collapsed ? " collapsed" : ""}">
      <button type="button" class="deckgroup-title" data-group-index="${i}">
        <span class="deckgroup-caret">${collapsed ? "▸" : "▾"}</span>
        ${g.label} <span class="muted">(${g.decks.length} deck${g.decks.length > 1 ? "s" : ""})</span>
      </button>
      <div class="decklist-wrap"><table class="decktable">${DECKTABLE_HEAD}
        <tbody>${g.decks.map(deckRowHtml).join("")}</tbody></table></div>
    </div>
  `;
  }).join("");
}

function toggleGroupCollapse(index){
  const key = lastGroupKeys[index];
  if (key === undefined) return;
  if (collapsedGroups.has(key)) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  if (lastDeckResults.length) renderDeckResults(lastDeckResults);
}

function selectedDeckColors(){
  return [...document.querySelectorAll('input[name="deckColor"]:checked')].map((el) => el.value);
}

// "Toutes les couleurs" n'est pas une couleur de plus : c'est l'état "aucune
// cochée", donc la pastille s'allume toute seule quand plus rien n'est coché.
function syncDeckColorAll(){
  document.getElementById("deckColorAll").classList.toggle("selected", !selectedDeckColors().length);
}

// silent=true est utilisé par le poll de progression de synchro pour
// rafraîchir les résultats sans effacer le statut/tableau à chaque tick
// (évite le clignotement "Recherche…"/tableau vide pendant l'import).
async function fetchAndRenderDecks(silent = false) {
  const q = deckCardQ.value.trim();
  const colors = selectedDeckColors();
  const { from, to } = selectedDeckDates();
  if (!silent) {
    deckSearchStatus.className = "status";
    deckSearchStatus.textContent = "Recherche…";
    deckResultsEl.innerHTML = "";
  }
  try {
    const params = new URLSearchParams({ q });
    if (colors.length) params.set("colors", colors.join(","));
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const res = await fetch(`/api/decks/by-card?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const decks = data.decks || [];
    lastDeckResults = decks;
    if (!decks.length) {
      if (!silent) {
        deckSearchStatus.textContent = (q || colors.length || from || to)
          ? "Aucun deck ne correspond (carte, couleurs, dates, ou base pas encore importée)."
          : "Base de decks locale vide — importe des decks d'abord.";
      }
      renderDeckResults(decks);
      return;
    }
    deckSearchStatus.textContent = `${decks.length} deck(s) trouvé(s).`;
    renderDeckResults(decks);
  } catch (err) {
    if (!silent) {
      deckSearchStatus.className = "status err";
      deckSearchStatus.textContent = `Erreur : ${err.message}`;
    } // échec du poll en arrière-plan : on ignore, le prochain tick réessaiera
  }
}
async function searchDecksByCard() { return fetchAndRenderDecks(false); }

// --- Aperçu de carte au survol ---
function wireCardPreview(){
  const cardPreviewEl = $("#cardPreview");
  const cardPreviewImg = cardPreviewEl.querySelector("img");

  function positionCardPreview(e){
    const margin = 16;
    const rect = cardPreviewEl.getBoundingClientRect();
    let x = e.clientX + margin;
    let y = e.clientY + margin;
    if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - margin;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - margin;
    cardPreviewEl.style.left = `${Math.max(4, x)}px`;
    cardPreviewEl.style.top = `${Math.max(4, y)}px`;
  }

  deckResultsEl.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-preview-set]");
    if (!el) return;
    const set = el.dataset.previewSet.toUpperCase();
    const number = el.dataset.previewNumber;
    cardPreviewImg.src = `https://cdn.swu-db.com/images/cards/${set}/${number}.png`;
    cardPreviewEl.classList.toggle("landscape", !!el.dataset.previewLandscape);
    cardPreviewEl.style.display = "block";
    positionCardPreview(e);
  });
  deckResultsEl.addEventListener("mousemove", (e) => {
    if (cardPreviewEl.style.display === "block") positionCardPreview(e);
  });
  deckResultsEl.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-preview-set]")) cardPreviewEl.style.display = "none";
  });
}

window.SWU_TABS.decks = function initDecksTab(){
  deckSyncBtn = $("#deckSync");
  deckClearBtn = $("#deckClear");
  deckSyncStatus = $("#deckSyncStatus");
  deckCardQ = $("#deckCardQ");
  deckSearchBtn = $("#deckSearch");
  deckSearchStatus = $("#deckSearchStatus");
  deckResultsEl = $("#deckResults");
  deckSortSel = $("#deckSort");
  deckGroupSel = $("#deckGroup");
  deckDbStatusEl = $("#deckDbStatus");
  deckPeriodSel = $("#deckPeriod");
  deckFromEl = $("#deckFrom");
  deckToEl = $("#deckTo");

  deckSyncBtn.addEventListener("click", async () => {
    deckSyncBtn.disabled = true;
    deckSyncBtn.classList.add("loading");
    deckSyncStatus.className = "status";
    deckSyncStatus.textContent = "Import en cours…";
    const progressTimer = setInterval(async () => {
      try {
        const res = await fetch("/api/decks/sync/progress");
        const p = await res.json();
        if (p.active) {
          deckSyncStatus.textContent = `Import en cours… ${p.imported}/${p.total} decks`;
          fetchAndRenderDecks(true);
        }
      } catch { /* tant pis, on attend juste la réponse finale */ }
    }, 1000);
    try {
      const res = await fetch("/api/decks/sync?format=Premier&limit=100", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      deckSyncStatus.textContent = `${data.imported} deck(s) importé(s) cette fois — ${data.total} au total dans la base locale.`;
    } catch (err) {
      deckSyncStatus.className = "status err";
      deckSyncStatus.textContent = `Erreur d'import : ${err.message}`;
    } finally {
      clearInterval(progressTimer);
      deckSyncBtn.classList.remove("loading");
      deckSyncBtn.disabled = false;
      refreshDeckDbStatus();
    }
  });

  deckClearBtn.addEventListener("click", async () => {
    if (!confirm("Vider toute la base de decks locale ? Cette action est irréversible.")) return;
    deckClearBtn.disabled = true;
    deckSyncStatus.className = "status";
    deckSyncStatus.textContent = "Suppression…";
    try {
      const res = await fetch("/api/decks", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      deckSyncStatus.textContent = "Base de decks locale vidée.";
      deckResultsEl.innerHTML = "";
      deckSearchStatus.textContent = "";
      refreshDeckDbStatus();
    } catch (err) {
      deckSyncStatus.className = "status err";
      deckSyncStatus.textContent = `Erreur : ${err.message}`;
    } finally {
      deckClearBtn.disabled = false;
    }
  });

  deckSortSel.addEventListener("change", () => { if (lastDeckResults.length) renderDeckResults(lastDeckResults); });
  deckGroupSel.addEventListener("change", () => { if (lastDeckResults.length) renderDeckResults(lastDeckResults); });
  deckResultsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".deckgroup-title");
    if (!btn) return;
    toggleGroupCollapse(Number(btn.dataset.groupIndex));
  });

  deckPeriodSel.addEventListener("change", () => { applyDeckPeriodPreset(); searchDecksByCard(); });
  // Toucher une date à la main sort du raccourci : l'étiquette doit suivre,
  // sinon le select afficherait "30 derniers jours" pour une plage qui n'en est
  // plus une.
  [deckFromEl, deckToEl].forEach((el) => el.addEventListener("change", () => {
    deckPeriodSel.value = (!deckFromEl.value && !deckToEl.value) ? "all" : "custom";
    searchDecksByCard();
  }));

  deckSearchBtn.addEventListener("click", searchDecksByCard);
  deckCardQ.addEventListener("keydown", (e) => { if (e.key === "Enter") searchDecksByCard(); });
  document.querySelectorAll('input[name="deckColor"]').forEach((el) => {
    el.addEventListener("change", () => { syncDeckColorAll(); searchDecksByCard(); });
  });
  document.getElementById("deckColorAll").addEventListener("click", () => {
    document.querySelectorAll('input[name="deckColor"]:checked').forEach((el) => (el.checked = false));
    syncDeckColorAll();
    searchDecksByCard();
  });

  wireCardPreview();
  refreshDeckDbStatus();
  loadMetaArchetypes();
};
