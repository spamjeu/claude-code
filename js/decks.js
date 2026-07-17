// Onglet "Base de decks". Ce fichier ne touche qu'à cet onglet (+ l'overlay
// #cardPreview, qui vit dans le shell index.html mais n'est utilisé que par
// les survols de cartes de cette base de decks).
let deckSyncBtn, deckSyncStatus, deckCardQ, deckSearchBtn, deckSearchStatus,
  deckResultsEl, deckSortSel, deckGroupSel, deckDbStatusEl;
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

function formatCooldown(ms){
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
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
    if (data.cooldownMs > 0) {
      deckSyncBtn.disabled = true;
      deckSyncBtn.title = `Prochaine synchro possible dans ${formatCooldown(data.cooldownMs)} (limite : une synchro toutes les 2h)`;
    } else {
      deckSyncBtn.disabled = false;
      deckSyncBtn.title = "";
    }
  } catch {
    deckDbStatusEl.textContent = "";
  }
}

function sortDecks(decks){
  const sorted = [...decks];
  if (deckSortSel.value === "leader") {
    sorted.sort((a, b) => (a.leaderName || "").localeCompare(b.leaderName || ""));
  } else {
    sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  }
  return sorted;
}

function colorDots(colors){
  if (!colors || !colors.length) return "";
  return colors.map((c) => `<img class="aspect-icon-sm" src="assets/aspects/${c.toLowerCase()}.png" alt="${c}" title="${c}" />`).join("");
}

function previewAttrs(set, number){
  return set && number ? `data-preview-set="${set}" data-preview-number="${number}"` : "";
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

function deckRowHtml(d){
  const matchesRow = d.matches.length ? `
    <tr class="deckrow-matches">
      <td colspan="6">
        <div class="badges-wrap">
          ${d.matches.map((m) => `<span class="badge" ${previewAttrs(m.set, m.number)}>${m.role}${m.count !== undefined ? `: ${m.count}x` : ""} ${m.name}${m.title ? " — " + m.title : ""} (${m.set || "?"}/${m.number || "?"})</span>`).join("")}
        </div>
      </td>
    </tr>` : "";
  return `
    <tr class="deckrow">
      <td class="col-likes">❤️ ${d.likeCount || 0}</td>
      <td class="col-aspects">${colorDots(d.colors)}</td>
      <td class="col-deck">
        <div class="deck-name-line"><a href="https://swudb.com/deck/${d.deckId}" target="_blank" rel="noopener">${d.deckName}</a> <span class="muted">par ${d.authorName}</span></div>
        <div class="deck-leader-line"><span ${previewAttrs(d.leaderSet, d.leaderNumber)}>${d.leaderName || "?"}</span>${d.baseName ? ` / <span ${previewAttrs(d.baseSet, d.baseNumber)}>${d.baseName}</span>` : ""}</div>
      </td>
      <td class="col-curve">${manaCurveHtml(d.manaCurve)}</td>
      <td class="col-winrate">${metaBadgeHtml(d) || `<span class="muted">—</span>`}</td>
      <td class="col-price"><span class="muted">—</span></td>
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
    const set = (d.matches[0] && d.matches[0].set) || "?";
    return { key: set, label: `Extension ${set}` };
  }
  return null;
}

const DECKTABLE_HEAD = `
  <thead><tr>
    <th>❤️</th><th>Couleurs</th><th>Deck</th><th>Courbe de mana</th><th>Winrate (ASH, Premier)</th><th>Prix</th>
  </tr></thead>`;

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
  deckResultsEl.innerHTML = [...groups.values()].map((g) => `
    <div class="deckgroup">
      <div class="deckgroup-title">${g.label} <span class="muted">(${g.decks.length} deck${g.decks.length > 1 ? "s" : ""})</span></div>
      <div class="decklist-wrap"><table class="decktable">${DECKTABLE_HEAD}
        <tbody>${g.decks.map(deckRowHtml).join("")}</tbody></table></div>
    </div>
  `).join("");
}

function selectedDeckColors(){
  return [...document.querySelectorAll('input[name="deckColor"]:checked')].map((el) => el.value);
}

// silent=true est utilisé par le poll de progression de synchro pour
// rafraîchir les résultats sans effacer le statut/tableau à chaque tick
// (évite le clignotement "Recherche…"/tableau vide pendant l'import).
async function fetchAndRenderDecks(silent = false) {
  const q = deckCardQ.value.trim();
  const colors = selectedDeckColors();
  if (!silent) {
    deckSearchStatus.className = "status";
    deckSearchStatus.textContent = "Recherche…";
    deckResultsEl.innerHTML = "";
  }
  try {
    const params = new URLSearchParams({ q });
    if (colors.length) params.set("colors", colors.join(","));
    const res = await fetch(`/api/decks/by-card?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const decks = data.decks || [];
    lastDeckResults = decks;
    if (!decks.length) {
      if (!silent) {
        deckSearchStatus.textContent = (q || colors.length)
          ? "Aucun deck ne correspond (carte, couleurs, ou base pas encore importée)."
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
  deckSyncStatus = $("#deckSyncStatus");
  deckCardQ = $("#deckCardQ");
  deckSearchBtn = $("#deckSearch");
  deckSearchStatus = $("#deckSearchStatus");
  deckResultsEl = $("#deckResults");
  deckSortSel = $("#deckSort");
  deckGroupSel = $("#deckGroup");
  deckDbStatusEl = $("#deckDbStatus");

  deckSyncBtn.addEventListener("click", async () => {
    deckSyncBtn.disabled = true;
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
      refreshDeckDbStatus();
    }
  });

  deckSortSel.addEventListener("change", () => { if (lastDeckResults.length) renderDeckResults(lastDeckResults); });
  deckGroupSel.addEventListener("change", () => { if (lastDeckResults.length) renderDeckResults(lastDeckResults); });

  deckSearchBtn.addEventListener("click", searchDecksByCard);
  deckCardQ.addEventListener("keydown", (e) => { if (e.key === "Enter") searchDecksByCard(); });
  document.querySelectorAll('input[name="deckColor"]').forEach((el) => {
    el.addEventListener("change", searchDecksByCard);
  });

  wireCardPreview();
  refreshDeckDbStatus();
  loadMetaArchetypes();
};
