// Onglet "Classeur" : simule un classeur 9 pochettes/page pour un set donné —
// leaders, puis bases sur une nouvelle page, puis le reste des cartes sur une
// nouvelle page. Les cartes viennent de /api/cards/set (server.js), qui les
// renvoie déjà triées par numéro de collection et réduites aux seuls champs
// utiles ici, avec une seule version par carte (= une pochette par carte).
//
// Tout est enfermé dans une IIFE : ce fichier manipule des noms très génériques
// (renderPage, buildPages…) et les onglets partagent le même scope global.
(function(){
  const PAGE_SIZE = 9;

  // Leaders et bases sont des cartes paysage, contrairement aux unités /
  // améliorations / événements — même constat que previewAttrs() dans
  // js/decks.js. Sans ça, object-fit:cover dans une pochette portrait rogne
  // leur illustration de moitié, et ce sont justement les deux groupes autour
  // desquels toute la mise en page du classeur est construite.
  const LANDSCAPE_TYPES = new Set(["Leader", "Base"]);

  function sectionLabel(card){
    if (!card) return "";
    if (card.Type === "Leader") return "Leaders";
    if (card.Type === "Base") return "Bases";
    return "Cartes";
  }

  function cardCaption(card){
    return `${card.Number} · ${card.Name}${card.Subtitle ? `, ${card.Subtitle}` : ""}`;
  }

  // Une pochette vide porte l'orientation de son groupe : une page de bases
  // (paysage) complétée par des pochettes portrait aurait des lignes de
  // hauteurs différentes.
  function toSlots(cards){
    return cards.map((card) => ({ card, landscape: LANDSCAPE_TYPES.has(card.Type) }));
  }

  // Complète jusqu'au prochain multiple de 9, pour que le groupe suivant
  // démarre toujours sur une page neuve — et que la dernière page ait bien ses
  // 9 emplacements, comme un vrai classeur.
  function padToPage(slots, landscape){
    const rem = slots.length % PAGE_SIZE;
    if (!rem) return slots;
    return slots.concat(Array.from({ length: PAGE_SIZE - rem }, () => ({ landscape })));
  }

  function buildPages(cards){
    const leaders = cards.filter((c) => c.Type === "Leader");
    const bases = cards.filter((c) => c.Type === "Base");
    const rest = cards.filter((c) => !LANDSCAPE_TYPES.has(c.Type));

    const slots = [
      ...padToPage(toSlots(leaders), true),
      ...padToPage(toSlots(bases), true),
      ...padToPage(toSlots(rest), false),
    ];

    const pages = [];
    for (let i = 0; i < slots.length; i += PAGE_SIZE) pages.push(slots.slice(i, i + PAGE_SIZE));
    return pages;
  }

  function renderPocket(slot){
    const pocket = document.createElement("div");
    pocket.className = "binder-pocket"
      + (slot.landscape ? " landscape" : "")
      + (slot.card ? "" : " empty");
    if (!slot.card) return pocket;

    const caption = cardCaption(slot.card);
    // title en plus de la légende au survol : au doigt et au clavier, un
    // :hover CSS seul rend le nom de la carte inatteignable.
    pocket.title = caption;

    if (slot.card.FrontArt){
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = slot.card.Name;
      // Une URL morte laisserait l'icône "image cassée" du navigateur au
      // milieu de la page : on repasse la pochette en placeholder.
      img.addEventListener("error", () => {
        img.remove();
        pocket.prepend(noArt(slot.card));
      });
      img.src = slot.card.FrontArt;
      pocket.appendChild(img);
    } else {
      pocket.appendChild(noArt(slot.card));
    }

    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = caption;
    pocket.appendChild(cap);
    return pocket;
  }

  function noArt(card){
    const el = document.createElement("div");
    el.className = "noart";
    el.textContent = card.Number;
    return el;
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

  window.SWU_TABS.binder = function initBinderTab(){
    const selectEl = $("#binderSet");
    const statusEl = $("#binderStatus");
    const pagesEl = $("#binderPages");

    window.SWU.fillSetOptions(selectEl, "ash");

    // Un set pas encore mis en cache côté serveur met une dizaine de secondes
    // à revenir : sans ce jeton, enchaîner deux sets ferait écraser le second
    // (rapide, déjà caché) par le premier quand il finit par arriver.
    let loadSeq = 0;

    function render(cards){
      const pages = buildPages(cards);
      const frag = document.createDocumentFragment();

      let prevLabel = null;
      pages.forEach((pageSlots, idx) => {
        const firstCard = pageSlots.map((s) => s.card).find(Boolean);
        const label = sectionLabel(firstCard);
        if (label && label !== prevLabel){
          const labelEl = document.createElement("div");
          labelEl.className = "binder-section-label";
          labelEl.textContent = label;
          frag.appendChild(labelEl);
          prevLabel = label;
        }
        frag.appendChild(renderPage(pageSlots, idx + 1));
      });

      pagesEl.innerHTML = "";
      pagesEl.appendChild(frag);
      statusEl.className = "status";
      statusEl.textContent = `${cards.length} carte(s) · ${pages.length} page(s)`;
    }

    async function load(set){
      const seq = ++loadSeq;
      pagesEl.innerHTML = "";
      statusEl.className = "status";
      statusEl.textContent = "Chargement du set…";
      try{
        const res = await fetch(`/api/cards/set?set=${encodeURIComponent(set)}`);
        const data = await res.json().catch(() => ({}));
        if (seq !== loadSeq) return; // un autre set a été demandé entre-temps
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const cards = data.cards || [];
        if (!cards.length){
          statusEl.textContent = "Aucune carte trouvée pour ce set.";
          return;
        }
        render(cards);
      }catch(err){
        if (seq !== loadSeq) return;
        statusEl.className = "status err";
        statusEl.textContent = `Erreur de chargement (${err.message}).`;
      }
    }

    selectEl.addEventListener("change", () => load(selectEl.value));
    load(selectEl.value);
  };
})();
