// Onglet "Deck Builder". Suggestions purement statistiques (co-occurrence
// dans data/decks.json côté serveur) — voir suggestCards() dans server.js
// pour le detail de comment le classement est calculé et pourquoi.
let dbLeaderSelect, dbCardQ, dbAddCardBtn, dbSelectedCardsEl, dbStatusEl, dbSuggestionsEl, dbResetBtn, dbCardNamesList;
let dbLeaders = [];
let selectedLeader = null; // { name, title, set, number, deckCount } | null
let selectedCards = []; // string[]

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

async function loadCardNames(){
  try {
    const res = await fetch("/api/deckbuilder/cardnames");
    const data = await res.json();
    dbCardNamesList.innerHTML = (data.names || []).map((n) => `<option value="${n}"></option>`).join("");
  } catch { /* pas grave, l'ajout manuel marche quand même sans autocomplete */ }
}

function renderSelectedCards(){
  dbSelectedCardsEl.innerHTML = selectedCards.map((name, i) =>
    `<button type="button" class="chip" data-remove="${i}" title="Retirer">${name} ✕</button>`
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
        <button type="button" class="chip" data-add="${s.name}">+ Ajouter à la sélection</button>
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
  if (selectedCards.length) params.set("cards", selectedCards.join(","));

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

function addCard(name){
  if (!name || selectedCards.includes(name)) return;
  selectedCards.push(name);
  renderSelectedCards();
  refreshSuggestions();
}

window.SWU_TABS.deckbuilder = function initDeckbuilderTab(){
  dbLeaderSelect = $("#dbLeaderSelect");
  dbCardQ = $("#dbCardQ");
  dbAddCardBtn = $("#dbAddCard");
  dbSelectedCardsEl = $("#dbSelectedCards");
  dbStatusEl = $("#dbStatus");
  dbSuggestionsEl = $("#dbSuggestions");
  dbResetBtn = $("#dbReset");
  dbCardNamesList = $("#dbCardNamesList");

  dbLeaderSelect.addEventListener("change", () => {
    selectedLeader = dbLeaderSelect.value === "" ? null : dbLeaders[Number(dbLeaderSelect.value)];
    refreshSuggestions();
  });

  dbAddCardBtn.addEventListener("click", () => {
    const name = dbCardQ.value.trim();
    addCard(name);
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
    addCard(btn.dataset.add);
  });

  dbResetBtn.addEventListener("click", () => {
    selectedLeader = null;
    selectedCards = [];
    dbLeaderSelect.value = "";
    renderSelectedCards();
    refreshSuggestions();
  });

  loadLeaders();
  loadCardNames();
  refreshSuggestions();
};
