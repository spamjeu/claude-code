const $ = (sel) => document.querySelector(sel);

// Thème : par défaut on suit la préférence système (aucun attribut = la media query
// prefers-color-scheme s'applique). Un clic force un choix explicite, mémorisé.
const themeToggleBtn = document.getElementById("themeToggle");
function systemPrefersLight(){ return window.matchMedia("(prefers-color-scheme: light)").matches; }
function applyTheme(theme){
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
  const effective = theme || (systemPrefersLight() ? "light" : "dark");
  themeToggleBtn.textContent = effective === "light" ? "☀️" : "🌙";
}
applyTheme(localStorage.getItem("swuTheme"));
themeToggleBtn.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || (systemPrefersLight() ? "light" : "dark");
  const next = current === "light" ? "dark" : "light";
  localStorage.setItem("swuTheme", next);
  applyTheme(next);
});

// Namespace partagé entre js/cards.js et js/decks.js : la date de départ de
// la période couverte par les stats swustats.net (renvoyée par le serveur,
// dérivée de ASH_RELEASE_DATE_MS dans server.js) est chargée par les deux
// onglets séparément mais affichée avec le même format des deux côtés.
window.SWU = {
  statsSeasonStart: null,

  // Les sets SWU, du plus récent au plus ancien. Partagé entre l'onglet
  // Recherche et l'onglet Classeur, qui remplissent tous les deux leur <select>
  // à partir d'ici : sans build step, un set ajouté à un seul des deux endroits
  // laisserait l'autre onglet silencieusement en retard d'une extension.
  // server.js garde sa propre copie (KNOWN_SETS) pour valider ce qu'il reçoit.
  SETS: [
    { code: "ash", label: "Ashes of the Empire (ASH)" },
    { code: "law", label: "A Lawless Time (LAW)" },
    { code: "sec", label: "Secrets of Power (SEC)" },
    { code: "lof", label: "Legends of the Force (LOF)" },
    { code: "jtl", label: "Jump to Lightspeed (JTL)" },
    { code: "twi", label: "Twilight of the Republic (TWI)" },
    { code: "shd", label: "Shadows of the Galaxy (SHD)" },
    { code: "sor", label: "Spark of Rebellion (SOR)" },
  ],
  // Ajoute une <option> par set au <select> donné, en gardant celles déjà
  // présentes dans le HTML (l'onglet Recherche y a un "Tous les sets" en tête).
  fillSetOptions(selectEl, selectedCode){
    for (const { code, label } of this.SETS){
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = label;
      opt.selected = code === selectedCode;
      selectEl.appendChild(opt);
    }
  },
  // Variante multi-sélection de fillSetOptions() pour l'onglet Recherche :
  // une case à cocher par set, aucune cochée = pas de filtre set.
  fillSetCheckboxes(containerEl, checkedCodes = []){
    for (const { code, label } of this.SETS){
      const wrap = document.createElement("label");
      wrap.className = "setbox";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = code;
      box.checked = checkedCodes.includes(code);
      wrap.appendChild(box);
      wrap.appendChild(document.createTextNode(label));
      containerEl.appendChild(wrap);
    }
  },
  formatFrDate(iso){
    if (!iso) return "";
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" });
  },
  seasonPeriodLabel(){
    return this.statsSeasonStart ? `depuis le ${this.formatFrDate(this.statsSeasonStart)}` : "";
  },
};

// --- Chargement des partials d'onglet + câblage des onglets ---
// Chaque onglet vit dans son propre fichier HTML (partials/<tab>.html) et son
// propre script (js/<tab>.js), qui expose window.SWU_TABS[name] = initFn.
// Une fois le HTML injecté dans le panneau correspondant, on appelle son
// initFn : c'est seulement à ce moment-là que ses éléments existent dans le
// DOM et que ses addEventListener peuvent s'accrocher.
window.SWU_TABS = {};

async function loadTabPanel(name){
  const panel = document.querySelector(`.tabpanel[data-tabpanel="${name}"]`);
  const res = await fetch(`partials/${name}.html`);
  panel.innerHTML = await res.text();
  if (window.SWU_TABS[name]) window.SWU_TABS[name]();
}

async function initTabs(){
  const names = [...document.querySelectorAll(".tabpanel")].map((p) => p.dataset.tabpanel);
  await Promise.all(names.map(loadTabPanel));

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tabpanel").forEach((p) => (p.hidden = true));
      btn.classList.add("active");
      document.querySelector(`.tabpanel[data-tabpanel="${btn.dataset.tab}"]`).hidden = false;
    });
  });
}
initTabs();
