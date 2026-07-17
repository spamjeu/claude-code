// Onglet "Deck Builder". Suggestions purement statistiques (co-occurrence
// dans data/decks.json côté serveur) — voir suggestCards() dans server.js
// pour le detail de comment le classement est calculé et pourquoi.
let dbLeaderSelect, dbBaseSelect, dbCardQ, dbCardCount, dbAddCardBtn, dbSelectedCardsEl,
  dbStatusEl, dbSuggestionsEl, dbResetBtn, dbCardNamesList, dbCopyJsonBtn, dbCopyStatusEl;
let dbLeaders = [];
let dbBases = [];
let dbCardRefsByName = new Map(); // name -> { set, number }, pour l'ajout manuel par texte
let selectedLeader = null; // { name, title, set, number, deckCount } | null
let selectedBase = null; // { name, title, set, number, deckCount } | null
let selectedCards = []; // [{ name, set, number, count }]

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

async function loadCardRefs(){
  try {
    const res = await fetch("/api/deckbuilder/cardnames");
    const data = await res.json();
    dbCardRefsByName = new Map((data.cards || []).map((c) => [c.name, c]));
    dbCardNamesList.innerHTML = (data.cards || []).map((c) => `<option value="${c.name}"></option>`).join("");
  } catch { /* pas grave, l'ajout manuel marche quand même sans autocomplete/set-number */ }
}

function renderSelectedCards(){
  dbSelectedCardsEl.innerHTML = selectedCards.map((c, i) =>
    `<button type="button" class="chip" data-remove="${i}" title="Retirer">${c.count}x ${c.name} ✕</button>`
  ).join("");
}

function renderSuggestions(suggestions){
  dbSuggestionsEl.innerHTML = suggestions.map((s) => {
    const defaultCount = Math.max(1, Math.min(3, Math.round(s.avgCopies) || 1));
    return `
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
        <div class="row db-suggest-add">
          <select class="db-suggest-count">
            <option value="1"${defaultCount === 1 ? " selected" : ""}>x1</option>
            <option value="2"${defaultCount === 2 ? " selected" : ""}>x2</option>
            <option value="3"${defaultCount === 3 ? " selected" : ""}>x3</option>
          </select>
          <button type="button" class="chip" data-add="${s.name}" data-set="${s.set || ""}" data-number="${s.number || ""}">+ Ajouter</button>
        </div>
      </div>
    </div>
  `;
  }).join("");
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

function addCard(name, count, set, number){
  if (!name || selectedCards.some((c) => c.name === name)) return;
  const ref = (set && number) ? { set, number } : dbCardRefsByName.get(name);
  selectedCards.push({
    name,
    set: (ref && ref.set) || "",
    number: (ref && ref.number) || "",
    count: Math.max(1, Math.min(3, count || 1)),
  });
  renderSelectedCards();
  refreshSuggestions();
}

// swudb.com (page "My Decks") a un bouton ".json" qui lit ce JSON depuis le
// presse-papier pour créer un deck directement — schéma confirmé à partir
// d'un vrai export swudb (fourni par l'utilisateur), pas une reconstruction :
// {metadata:{name,author}, leader:{id,count}, base:{id,count}, deck:[{id,count}], sideboard:[]}
// où id = "SET_NUMERO" (ex: "ASH_009"), exactement le format de nos refs
// locales (set en majuscules + numéro sur 3 chiffres).
function cardId(ref){
  return `${(ref.set || "").toUpperCase()}_${ref.number || ""}`;
}

function buildDeckJson(){
  return {
    metadata: {
      name: selectedLeader ? `${selectedLeader.name} (Deck Builder)` : "Deck Builder export",
      author: "",
    },
    leader: selectedLeader ? { id: cardId(selectedLeader), count: 1 } : null,
    base: selectedBase ? { id: cardId(selectedBase), count: 1 } : null,
    deck: selectedCards.filter((c) => c.set && c.number).map((c) => ({ id: cardId(c), count: c.count })),
    sideboard: [],
  };
}

// swudb.com refuse l'import si le leader ou la base manque dans le JSON —
// pas la peine de laisser copier un JSON qu'on sait déjà cassé côté import.
function updateCopyButtonState(){
  dbCopyJsonBtn.disabled = !selectedLeader || !selectedBase;
  dbCopyJsonBtn.title = dbCopyJsonBtn.disabled ? "Choisis un leader ET une base avant de pouvoir exporter." : "";
}

async function copyDeckJson(){
  if (!selectedLeader || !selectedBase) {
    dbCopyStatusEl.className = "status err";
    dbCopyStatusEl.textContent = "Choisis un leader ET une base avant de copier — sans les deux, l'import échoue côté swudb.";
    return;
  }
  const payload = buildDeckJson();
  const missingIds = selectedCards.filter((c) => !c.set || !c.number).map((c) => c.name);
  const text = JSON.stringify(payload, null, 1);
  try {
    await navigator.clipboard.writeText(text);
    dbCopyStatusEl.className = missingIds.length ? "status err" : "status";
    dbCopyStatusEl.textContent = missingIds.length
      ? `Copié, mais ${missingIds.length} carte(s) sans set/numéro connu n'ont pas pu être incluses : ${missingIds.join(", ")}.`
      : `Copié (${payload.deck.reduce((n, c) => n + c.count, 0)} carte(s) + leader/base si choisis). Va sur swudb.com → "My Decks" → bouton ".json".`;
  } catch (err) {
    dbCopyStatusEl.className = "status err";
    dbCopyStatusEl.textContent = `Impossible de copier automatiquement (${err.message}).`;
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
  dbCopyJsonBtn = $("#dbCopyJson");
  dbCopyStatusEl = $("#dbCopyStatus");

  dbLeaderSelect.addEventListener("change", () => {
    selectedLeader = dbLeaderSelect.value === "" ? null : dbLeaders[Number(dbLeaderSelect.value)];
    updateCopyButtonState();
    refreshSuggestions();
  });
  dbBaseSelect.addEventListener("change", () => {
    selectedBase = dbBaseSelect.value === "" ? null : dbBases[Number(dbBaseSelect.value)];
    updateCopyButtonState();
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
    const countSel = btn.closest(".body").querySelector(".db-suggest-count");
    addCard(btn.dataset.add, Number(countSel.value), btn.dataset.set, btn.dataset.number);
  });

  dbResetBtn.addEventListener("click", () => {
    selectedLeader = null;
    selectedBase = null;
    selectedCards = [];
    dbLeaderSelect.value = "";
    dbBaseSelect.value = "";
    dbCopyStatusEl.textContent = "";
    renderSelectedCards();
    updateCopyButtonState();
    refreshSuggestions();
  });

  dbCopyJsonBtn.addEventListener("click", copyDeckJson);

  updateCopyButtonState();
  loadLeaders();
  loadBases();
  loadCardRefs();
  refreshSuggestions();
};
