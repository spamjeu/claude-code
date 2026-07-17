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
