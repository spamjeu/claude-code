// Onglet "Deck Builder". Suggestions purement statistiques (co-occurrence
// dans data/decks.json côté serveur) — voir suggestCards() dans server.js
// pour le detail de comment le classement est calculé et pourquoi.
let dbLeaderSelect, dbBaseSelect, dbCardQ, dbCardCount, dbAddCardBtn, dbSelectedCardsEl,
  dbStatusEl, dbSuggestionsEl, dbResetBtn, dbCardNamesList, dbCopyMeleeBtn, dbCopyStatusEl;
let dbLeaders = [];
let dbBases = [];
let selectedLeader = null; // { name, title, set, number, deckCount } | null
let selectedBase = null; // { name, title, set, number, deckCount } | null
let selectedCards = []; // [{ name, count }]

async function loadLeaders(){
  try {
    const res = await fetch("/api/deckbuilder/leaders");
    const data = await res.json();
    dbLeaders = data.leaders || [];
    dbLeaderSelect.innerHTML = '<option value="">Choisis un leader (optionnel)</option>' +
      dbLeaders.map((l, i) => `<option value="${i}">${l.name}${l.title ? " — " + l.title : ""} (${l.deckCount} deck${l.deckCount > 1 ? "s" : ""})</option>`).join("");
  } catch {
    dbStatusEl.className = "status err";
    dbStatusEl.textContent = "Impossible de charger la liste des leaders.";
  }
}

async function loadBases(){
  try {
    const res = await fetch("/api/deckbuilder/bases");
    const data = await res.json();
    dbBases = data.bases || [];
    dbBaseSelect.innerHTML = '<option value="">Choisis une base (optionnel)</option>' +
      dbBases.map((b, i) => `<option value="${i}">${b.name}${b.title ? " — " + b.title : ""} (${b.deckCount} deck${b.deckCount > 1 ? "s" : ""})</option>`).join("");
  } catch { /* pas grave, la base reste optionnelle pour les suggestions */ }
}

async function loadCardNames(){
  try {
    const res = await fetch("/api/deckbuilder/cardnames");
    const data = await res.json();
    dbCardNamesList.innerHTML = (data.names || []).map((n) => `<option value="${n}"></option>`).join("");
  } catch { /* pas grave, l'ajout manuel marche quand même sans autocomplete */ }
}

function renderSelectedCards(){
  dbSelectedCardsEl.innerHTML = selectedCards.map((c, i) =>
    `<button type="button" class="chip" data-remove="${i}" title="Retirer">${c.count}x ${c.name} ✕</button>`
  ).join("");
}

function renderSuggestions(suggestions){
  dbSuggestionsEl.innerHTML = suggestions.map((s) => `
    <div class="card">
      <div class="art">${s.set && s.number ? `<img loading="lazy" src="https://cdn.swu-db.com/images/cards/${s.set}/${s.number}.png" alt="${s.name}">` : `<div class="noimg">Pas d'image<br>disponible</div>`}</div>
      <div class="body">
        <div class="name">${s.name}</div>
        ${s.title ? `<div class="sub">${s.title}</div>` : ""}
        <div class="badges">
          <span class="badge">${Math.round(s.deckShare * 100)}% des decks</span>
          <span class="badge">${s.deckCount} deck${s.deckCount > 1 ? "s" : ""}</span>
          ${s.avgCopies > 1 ? `<span class="badge">~${s.avgCopies}x en moyenne</span>` : ""}
        </div>
        <button type="button" class="chip" data-add="${s.name}" data-count="${Math.max(1, Math.min(3, Math.round(s.avgCopies) || 1))}">+ Ajouter à la sélection</button>
      </div>
    </div>
  `).join("");
}

async function refreshSuggestions(){
  if (!selectedLeader && !selectedCards.length) {
    dbStatusEl.className = "status";
    dbStatusEl.textContent = "Choisis un leader et/ou ajoute des cartes pour voir des suggestions.";
    dbSuggestionsEl.innerHTML = "";
    return;
  }
  const params = new URLSearchParams();
  if (selectedLeader) {
    params.set("leaderName", selectedLeader.name);
    if (selectedLeader.title) params.set("leaderTitle", selectedLeader.title);
  }
  if (selectedCards.length) params.set("cards", selectedCards.map((c) => c.name).join(","));

  dbStatusEl.className = "status";
  dbStatusEl.textContent = "Calcul en cours…";
  try {
    const res = await fetch(`/api/deckbuilder/suggest?${params}`);
    const data = await res.json();
    if (!data.matchingDecks) {
      dbStatusEl.textContent = "Aucun deck local ne correspond à cette combinaison (essaie d'enlever une carte, de changer de leader, ou importe plus de decks dans l'onglet Base de decks).";
      dbSuggestionsEl.innerHTML = "";
      return;
    }
    dbStatusEl.textContent = `Basé sur ${data.matchingDecks} deck(s) local(aux) correspondant(s).`;
    renderSuggestions(data.suggestions);
  } catch (err) {
    dbStatusEl.className = "status err";
    dbStatusEl.textContent = `Erreur : ${err.message}`;
  }
}

function addCard(name, count){
  if (!name || selectedCards.some((c) => c.name === name)) return;
  selectedCards.push({ name, count: Math.max(1, Math.min(3, count || 1)) });
  renderSelectedCards();
  refreshSuggestions();
}

// Reconstruction "au mieux" du format texte Melee.gg pour Star Wars: Unlimited
// (doc publique incomplète sur la syntaxe exacte — sections Leader/Base/Deck,
// une carte par ligne "N Nom"). swudb.com/decks (page "My Decks") a un bouton
// "Melee" qui lit ce texte depuis le presse-papier pour créer un deck — voir
// useDeckActions dans leur bundle JS (importDeckFromMeleeText). Si l'import
// échoue côté swudb, leur message d'erreur donnera de quoi corriger le format.
function buildMeleeText(){
  const lines = [];
  if (selectedLeader) {
    lines.push("Leader");
    lines.push(`1 ${selectedLeader.name}${selectedLeader.title ? " | " + selectedLeader.title : ""}`);
    lines.push("");
  }
  if (selectedBase) {
    lines.push("Base");
    lines.push(`1 ${selectedBase.name}${selectedBase.title ? " | " + selectedBase.title : ""}`);
    lines.push("");
  }
  lines.push("Deck");
  for (const c of selectedCards) lines.push(`${c.count} ${c.name}`);
  return lines.join("\n");
}

async function copyMeleeText(){
  if (!selectedLeader && !selectedBase && !selectedCards.length) {
    dbCopyStatusEl.className = "status";
    dbCopyStatusEl.textContent = "Choisis au moins un leader, une base ou des cartes avant de copier.";
    return;
  }
  const text = buildMeleeText();
  try {
    await navigator.clipboard.writeText(text);
    dbCopyStatusEl.className = "status";
    dbCopyStatusEl.textContent = `Copié (${selectedCards.reduce((n, c) => n + c.count, 0)} carte(s) + leader/base si choisis). Va sur swudb.com → "My Decks" → bouton "Melee".`;
  } catch (err) {
    dbCopyStatusEl.className = "status err";
    dbCopyStatusEl.textContent = `Impossible de copier automatiquement (${err.message}) — texte : ${text.replace(/\n/g, " / ")}`;
  }
}

window.SWU_TABS.deckbuilder = function initDeckbuilderTab(){
  dbLeaderSelect = $("#dbLeaderSelect");
  dbBaseSelect = $("#dbBaseSelect");
  dbCardQ = $("#dbCardQ");
  dbCardCount = $("#dbCardCount");
  dbAddCardBtn = $("#dbAddCard");
  dbSelectedCardsEl = $("#dbSelectedCards");
  dbStatusEl = $("#dbStatus");
  dbSuggestionsEl = $("#dbSuggestions");
  dbResetBtn = $("#dbReset");
  dbCardNamesList = $("#dbCardNamesList");
  dbCopyMeleeBtn = $("#dbCopyMelee");
  dbCopyStatusEl = $("#dbCopyStatus");

  dbLeaderSelect.addEventListener("change", () => {
    selectedLeader = dbLeaderSelect.value === "" ? null : dbLeaders[Number(dbLeaderSelect.value)];
    refreshSuggestions();
  });
  dbBaseSelect.addEventListener("change", () => {
    selectedBase = dbBaseSelect.value === "" ? null : dbBases[Number(dbBaseSelect.value)];
  });

  dbAddCardBtn.addEventListener("click", () => {
    const name = dbCardQ.value.trim();
    addCard(name, Number(dbCardCount.value));
    dbCardQ.value = "";
  });
  dbCardQ.addEventListener("keydown", (e) => { if (e.key === "Enter") dbAddCardBtn.click(); });

  dbSelectedCardsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    selectedCards.splice(Number(btn.dataset.remove), 1);
    renderSelectedCards();
    refreshSuggestions();
  });

  dbSuggestionsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-add]");
    if (!btn) return;
    addCard(btn.dataset.add, Number(btn.dataset.count));
  });

  dbResetBtn.addEventListener("click", () => {
    selectedLeader = null;
    selectedBase = null;
    selectedCards = [];
    dbLeaderSelect.value = "";
    dbBaseSelect.value = "";
    dbCopyStatusEl.textContent = "";
    renderSelectedCards();
    refreshSuggestions();
  });

  dbCopyMeleeBtn.addEventListener("click", copyMeleeText);

  loadLeaders();
  loadBases();
  loadCardNames();
  refreshSuggestions();
};
