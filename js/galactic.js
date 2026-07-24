window.SWU_TABS = window.SWU_TABS || {};

window.SWU_TABS.galactic = function initGalactic() {
  const playersEl = document.getElementById("galPlayers");
  const tournamentsEl = document.getElementById("galTournaments");
  const statusEl = document.getElementById("galStatus");
  const refreshBtn = document.getElementById("galRefresh");

  // Player names, opponent names, round labels, etc. come straight from
  // melee.gg's own data — escape before building innerHTML strings with them.
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtTime(iso) {
    if (!iso) return "jamais";
    return new Date(iso).toLocaleTimeString("fr-FR");
  }

  function decklistLinksHtml(decklists) {
    if (!decklists || !decklists.length) return "";
    return decklists.map((d) =>
      `<a href="https://melee.gg/Decklist/View/${esc(d.id)}" target="_blank" rel="noopener" class="badge">📄 ${esc(d.name)}</a>`
    ).join(" ");
  }

  function renderPlayerCard(name, occurrences) {
    const div = document.createElement("div");
    div.className = "panel gal-player-card";
    if (!occurrences.length) {
      div.innerHTML = `<strong>${esc(name)}</strong><div class="status">Pas encore repéré dans un tournoi.</div>`;
      return div;
    }
    const blocks = occurrences.map(({ tournamentLabel, standing, matches }) => {
      const parts = [];
      if (standing) {
        const ownDeck = decklistLinksHtml(standing.decklists);
        parts.push(`
          <div class="gal-standing">
            <div class="gal-round-label">Classement — ${esc(standing.roundName)}</div>
            <div class="gal-stats">
              <div class="gal-stat"><div class="gal-stat-value">#${esc(standing.rank)}</div><div class="gal-stat-label">Rang</div></div>
              <div class="gal-stat"><div class="gal-stat-value">${esc(standing.matchRecord)}</div><div class="gal-stat-label">Matchs</div></div>
              <div class="gal-stat"><div class="gal-stat-value">${esc(standing.gameRecord)}</div><div class="gal-stat-label">Parties</div></div>
              <div class="gal-stat"><div class="gal-stat-value">${esc(standing.points)}</div><div class="gal-stat-label">Points</div></div>
            </div>
            ${ownDeck ? `<div style="margin-top:6px">${ownDeck}</div>` : ""}
          </div>`);
      }
      if (matches && matches.length) {
        const rows = matches.map((m) => {
          const opponents = (m.opponents || []).map(esc).join(", ") || "?";
          const opponentDeck = decklistLinksHtml(m.opponentDecklists);
          const score = esc(m.score || m.result || "en cours");
          return `
            <div class="gal-match-row gal-outcome-${esc(m.outcome || "pending")}">
              <span class="gal-match-round">${esc(m.roundName)}</span>
              <span class="gal-match-vs">VS <strong>${opponents}</strong>${opponentDeck ? ` ${opponentDeck}` : ""}</span>
              <span class="gal-match-score">${score}</span>
            </div>`;
        }).join("");
        parts.push(`<div class="gal-matches"><div class="gal-round-label">Matchs</div>${rows}</div>`);
      }
      return `<div class="gal-tournament-block"><div class="badge">${esc(tournamentLabel)}</div>${parts.join("")}</div>`;
    }).join("");
    div.innerHTML = `<strong>${esc(name)}</strong>${blocks}`;
    return div;
  }

  function render(data) {
    const tournaments = Object.values(data.tournaments || {});
    const trackedPlayers = data.trackedPlayers || [];

    playersEl.innerHTML = "";
    trackedPlayers.forEach((name) => {
      const occurrences = tournaments
        .filter((t) => t.players && t.players[name])
        .map((t) => ({ tournamentLabel: t.name || t.label, ...t.players[name] }));
      playersEl.appendChild(renderPlayerCard(name, occurrences));
    });

    tournamentsEl.innerHTML = tournaments.map((t) => {
      const statusBadge = t.status === "error" ? `erreur (${esc(t.error || "?")})` : esc(t.statusDescription || t.status);
      const count = t.playerCount != null ? ` — ${esc(t.playerCount)} joueurs` : "";
      return `<div>${esc(t.name || t.label)} — <span class="badge">${statusBadge}</span>${count}</div>`;
    }).join("") || "En attente de la première actualisation…";
  }

  async function refresh(force) {
    statusEl.classList.remove("err");
    statusEl.textContent = force ? "Actualisation en cours (peut prendre quelques secondes)…" : "Chargement…";
    try {
      const res = await fetch(force ? "/api/galactic/refresh" : "/api/galactic/status", { method: force ? "POST" : "GET" });
      const data = await res.json();
      if (data.error) {
        statusEl.classList.add("err");
        statusEl.textContent = data.error;
        return;
      }
      render(data);
      const errSuffix = data.lastError ? ` (dernière erreur melee.gg : ${data.lastError})` : "";
      statusEl.textContent = `Dernière actualisation : ${fmtTime(data.lastPolled)}${errSuffix}`;
    } catch (err) {
      statusEl.classList.add("err");
      statusEl.textContent = `Erreur : ${err.message}`;
    }
  }

  refreshBtn.addEventListener("click", () => refresh(true));
  refresh(false);
  // Cette boucle interroge seulement le cache local (data/galactic.json) —
  // aucun appel melee.gg supplémentaire ici, ça reste bon marché. Le vrai
  // rafraîchissement melee.gg (toutes les 5 min) tourne côté serveur.
  setInterval(() => refresh(false), 30000);
};
