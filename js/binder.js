// Onglet "Classeur" : simule un classeur 9 pochettes/page pour un set donné —
// leaders, puis bases sur une nouvelle page, puis le reste des cartes sur une
// nouvelle page. Les cartes viennent de /api/cards/set (server.js), qui ne
// renvoie que la version "Normal" de chaque carte (une pochette par carte).

function sectionLabel(card){
  if (!card) return "";
  if (card.Type === "Leader") return "Leaders";
  if (card.Type === "Base") return "Bases";
  return "Cartes";
}

function toSlots(cards){
  return cards.map((card) => ({ card }));
}

// Complète avec des pochettes vides jusqu'au prochain multiple de 9, pour que
// le groupe suivant démarre toujours sur une page neuve.
function padToPage(slots){
  const rem = slots.length % 9;
  if (!rem) return slots;
  return slots.concat(Array.from({ length: 9 - rem }, () => ({})));
}

function chunk9(slots){
  const pages = [];
  for (let i = 0; i < slots.length; i += 9) pages.push(slots.slice(i, i + 9));
  return pages;
}

function renderPocket(slot){
  const pocket = document.createElement("div");
  if (!slot.card){
    pocket.className = "binder-pocket empty";
    return pocket;
  }
  pocket.className = "binder-pocket";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.src = slot.card.FrontArt || "";
  img.alt = slot.card.Name || "";
  pocket.appendChild(img);
  const cap = document.createElement("div");
  cap.className = "cap";
  const subtitle = slot.card.Subtitle ? `, ${slot.card.Subtitle}` : "";
  cap.textContent = `${slot.card.Number} · ${slot.card.Name}${subtitle}`;
  pocket.appendChild(cap);
  return pocket;
}

function renderPage(pageSlots, pageNumber){
  const pageEl = document.createElement("div");
  pageEl.className = "binder-page";

  const pageNum = document.createElement("div");
  pageNum.className = "binder-page-num";
  pageNum.textContent = `Page ${pageNumber}`;
  pageEl.appendChild(pageNum);

  const grid = document.createElement("div");
  grid.className = "binder-grid";
  pageSlots.forEach((slot) => grid.appendChild(renderPocket(slot)));
  pageEl.appendChild(grid);

  return pageEl;
}

function buildPages(cards){
  const leaders = cards.filter((c) => c.Type === "Leader");
  const bases = cards.filter((c) => c.Type === "Base");
  const rest = cards.filter((c) => c.Type !== "Leader" && c.Type !== "Base");

  const slots = [
    ...padToPage(toSlots(leaders)),
    ...padToPage(toSlots(bases)),
    ...toSlots(rest),
  ];
  return chunk9(slots);
}

window.SWU_TABS.binder = function initBinderTab(){
  const selectEl = $("#binderSet");
  const statusEl = $("#binderStatus");
  const pagesEl = $("#binderPages");

  function render(cards){
    const pages = buildPages(cards);
    pagesEl.innerHTML = "";

    let prevLabel = null;
    pages.forEach((pageSlots, idx) => {
      const firstCard = pageSlots.map((s) => s.card).find(Boolean);
      const label = sectionLabel(firstCard);
      if (label && label !== prevLabel){
        const labelEl = document.createElement("div");
        labelEl.className = "binder-section-label";
        labelEl.textContent = label;
        pagesEl.appendChild(labelEl);
        prevLabel = label;
      }
      pagesEl.appendChild(renderPage(pageSlots, idx + 1));
    });

    statusEl.className = "status";
    statusEl.textContent = `${cards.length} carte(s) · ${pages.length} page(s)`;
  }

  async function load(set){
    pagesEl.innerHTML = "";
    statusEl.className = "status";
    statusEl.textContent = "Chargement du set…";
    try{
      const res = await fetch(`/api/cards/set?set=${encodeURIComponent(set)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const cards = data.cards || [];
      if (!cards.length){
        statusEl.textContent = "Aucune carte trouvée pour ce set.";
        return;
      }
      render(cards);
    }catch(err){
      statusEl.className = "status err";
      statusEl.textContent = `Erreur de chargement (${err.message}).`;
    }
  }

  selectEl.addEventListener("change", () => load(selectEl.value));
  load(selectEl.value);
};
