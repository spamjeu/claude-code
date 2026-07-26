window.SWU_TABS = window.SWU_TABS || {};

window.SWU_TABS.galactic = function initGalactic() {
  const playersEl = document.getElementById("galPlayers");
  const tournamentsEl = document.getElementById("galTournaments");
  const statusEl = document.getElementById("galStatus");
  const refreshBtn = document.getElementById("galRefresh");

  const FR_STATUS = { Registration: "Inscriptions", "In Progress": "En cours", Ended: "Terminé" };
  // melee.gg's own Team.StatusDescription for a dropped player — translated
  // for display, raw text kept as a fallback for values not seen yet.
  const DROP_LABELS = {
    "Dropped (Self)": "Abandon",
    "Dropped (TO)": "Retiré par l'organisateur",
    "Disqualified": "Disqualifié",
  };
  const baseTitle = document.title;

  // Player names, opponent names, round labels, etc. come straight from
  // melee.gg's own data — escape before building innerHTML strings with them.
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtTime(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "jamais";
    return d.toLocaleTimeString("fr-FR");
  }

  // Le serveur ne poll que toutes les 5 min et un cycle raté laisse lastPolled
  // inchangé : un âge dit tout de suite que les données sont gelées, pas une heure.
  function fmtAge(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "jamais";
    const min = Math.round((Date.now() - d) / 60000);
    return min < 1 ? "à l'instant" : `il y a ${min} min`;
  }

  function decklistLinksHtml(decklists) {
    if (!decklists || !decklists.length) return "";
    return decklists.map((d) =>
      `<a href="https://melee.gg/Decklist/View/${esc(d.id)}" target="_blank" rel="noopener" class="badge gal-deck" title="${esc(d.name)}">📄 ${esc(d.name)}</a>`
    ).join(" ");
  }

  // On se fie au statut melee.gg, pas aux matchs : entre deux rondes d'un
  // tournoi en cours, aucun match n'est "pending" (la ronde suivante n'est pas
  // encore appariée) — le déduire des matchs replierait un event actif.
  function isEventFinished(t) {
    return t.statusDescription === "Ended" || t.status === "finished";
  }

  // Joueur sorti/droppé. melee.gg le dit explicitement sur le classement
  // (Team.IsActive) — fiable dès qu'un classement a été récupéré après le
  // drop. Sinon on retombe sur l'heuristique : moins de matchs que de rondes
  // lancées, et rien en attente.
  function isPlayerOut({ matches, rounds, standing }) {
    if (standing && standing.isActive === false) return true;
    return !!(matches && matches.length && rounds && matches.length < rounds
      && matches.every((m) => m.outcome !== "pending"));
  }

  function record(occurrences) {
    const tally = { win: 0, loss: 0, draw: 0 };
    occurrences.forEach((o) => (o.matches || []).forEach((m) => {
      if (tally[m.outcome] != null) tally[m.outcome]++;
    }));
    return `${tally.win}-${tally.loss}-${tally.draw}`;
  }

  // Data auto-refreshes every 30s; without this, a manual expand/collapse
  // click would get silently undone by the next refresh.
  const collapsedOverrides = {};

  function renderPlayerCard(name, occurrences) {
    const div = document.createElement("div");
    div.className = "panel gal-player-card";
    if (!occurrences.length) {
      div.innerHTML = `<strong>${esc(name)}</strong><div class="status">Pas encore repéré dans un tournoi.</div>`;
      return div;
    }
    const blocks = occurrences.map(({ tournamentId, tournamentLabel, standing, matches, isFinished, playerOut }) => {
      const parts = [];
      if (standing) {
        const ownDeck = decklistLinksHtml(standing.decklists);
        const dropLabel = standing.isActive === false
          ? (DROP_LABELS[standing.status] || standing.status || "Abandon")
          : null;
        const dropBadge = dropLabel
          ? ` <span class="badge bad" style="text-transform:none" title="${esc(standing.status || "")}">${esc(dropLabel)}</span>`
          : "";
        parts.push(`
          <div class="gal-standing">
            <div class="gal-round-label">Classement — ${esc(standing.roundName)}${dropBadge}</div>
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
          const opponents = (m.opponents || []).map((o) => {
            const rankBadge = o.rank != null ? ` <span class="badge">#${esc(o.rank)}</span>` : "";
            return `<strong>${esc(o.name)}</strong>${rankBadge}`;
          }).join(", ") || "?";
          const opponentDeck = decklistLinksHtml(m.opponentDecklists);
          const table = m.table ? `<span class="gal-match-table">T${esc(m.table)}</span>` : "";
          const score = esc(m.score || (m.outcome === "pending" ? "en cours" : m.result || "—"));
          return `
            <div class="gal-match-row gal-outcome-${esc(m.outcome || "pending")}">
              <span class="gal-match-round">${esc(m.roundName)}</span>${table}
              <span class="gal-match-vs">VS ${opponents}${opponentDeck ? ` ${opponentDeck}` : ""}</span>
              <span class="gal-match-score">${score}</span>
            </div>`;
        }).join("");
        parts.push(`<div class="gal-matches"><div class="gal-round-label">Matchs</div>${rows}</div>`);
      }
      // Clé sur l'id : melee.gg renomme parfois un tournoi en cours de route.
      const overrideKey = `${name}::${tournamentId}`;
      const collapsed = Object.hasOwn(collapsedOverrides, overrideKey) ? collapsedOverrides[overrideKey] : isFinished;
      // Un bloc replié doit rester informatif, sinon la carte n'est plus qu'une
      // liste de titres : rang + record, et surtout la ronde en cours.
      const live = (matches || []).find((m) => m.outcome === "pending");
      const dropLabel = standing && standing.isActive === false
        ? (DROP_LABELS[standing.status] || standing.status || "Abandon")
        : null;
      const summary = [
        standing ? `#${esc(standing.rank)} · ${esc(standing.matchRecord)}` : "",
        live ? `<span class="gal-live">● ${esc(live.roundName)}</span>` : (playerOut && !isFinished ? `<span class="gal-out">${esc(dropLabel || "éliminé")}</span>` : ""),
      ].filter(Boolean).join(" · ");
      return `<div class="gal-tournament-block${collapsed ? " collapsed" : ""}" data-override-key="${esc(overrideKey)}">
        <div class="gal-tournament-header" role="button" tabindex="0" aria-expanded="${!collapsed}">
          <span class="gal-tournament-toggle">▾</span>
          <span class="gal-tournament-name" title="${esc(tournamentLabel)}">${esc(tournamentLabel)}</span>
          <span class="gal-tournament-summary">${summary}</span>
        </div>
        <div class="gal-tournament-body">${parts.join("")}</div>
      </div>`;
    }).join("");
    div.innerHTML = `<strong>${esc(name)}</strong>
      <div class="gal-player-sum">${occurrences.length} tournoi${occurrences.length > 1 ? "s" : ""} · ${record(occurrences)}</div>
      ${blocks}`;
    div.querySelectorAll(".gal-tournament-header").forEach((header) => {
      const toggle = () => {
        const block = header.closest(".gal-tournament-block");
        const collapsed = block.classList.toggle("collapsed");
        header.setAttribute("aria-expanded", String(!collapsed));
        collapsedOverrides[block.dataset.overrideKey] = collapsed;
      };
      header.addEventListener("click", toggle);
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
    return div;
  }

  let firstRender = true;

  function render(data) {
    const byId = data.tournaments || {};
    // L'ordre des clés d'un objet suit les entiers croissants, pas l'ordre
    // déclaré côté serveur — d'où la liste `order` renvoyée par l'API.
    const order = (data.order && data.order.length) ? data.order : Object.keys(byId);
    const tournaments = order.map((id) => byId[id]).filter(Boolean);
    const trackedPlayers = data.trackedPlayers || [];
    let anyLive = false;

    playersEl.innerHTML = "";
    trackedPlayers.forEach((name) => {
      const occurrences = tournaments
        .filter((t) => t.players && t.players[name])
        .map((t) => ({
          tournamentId: t.id,
          tournamentLabel: t.name || t.label,
          isFinished: isEventFinished(t),
          rounds: t.rounds,
          ...t.players[name],
        }))
        .map((occ) => ({ ...occ, playerOut: isPlayerOut(occ) }))
        // Event en cours d'abord, events terminés relégués en dessous.
        .sort((a, b) => a.isFinished - b.isFinished);
      if (occurrences.some((o) => (o.matches || []).some((m) => m.outcome === "pending"))) anyLive = true;
      const card = renderPlayerCard(name, occurrences);
      // Le rendu n'a lieu que sur données réellement neuves (cf. refresh) :
      // un flash discret rend le changement visible sans avoir à comparer.
      if (!firstRender) {
        card.classList.add("gal-updated");
        setTimeout(() => card.classList.remove("gal-updated"), 2000);
      }
      playersEl.appendChild(card);
    });
    firstRender = false;
    document.title = anyLive ? `🔴 ${baseTitle}` : baseTitle;

    tournamentsEl.innerHTML = tournaments.map((t) => {
      const cls = t.status === "error" ? "bad" : t.status === "started" ? "live" : "";
      const label = t.status === "error" ? "erreur" : esc(FR_STATUS[t.statusDescription] || t.statusDescription || t.status);
      // Message d'erreur melee.gg en title : inline, il casserait la mise en page.
      const title = t.error ? ` title="${esc(t.error)}"` : "";
      const count = t.playerCount != null ? `<span class="gal-hub-count">${esc(t.playerCount)} joueurs</span>` : "";
      return `<div class="gal-hub-row">
        <a href="https://melee.gg/Tournament/View/${esc(t.id)}" target="_blank" rel="noopener">${esc(t.name || t.label)}</a>
        <span class="badge ${cls}"${title}>${label}</span>${count}
      </div>`;
    }).join("") || "En attente de la première actualisation…";
  }

  let busy = false;
  let renderedToken = null;

  async function refresh(force) {
    // Un refresh forcé dure ~30s (5 tournois x requêtes espacées) : sans ce
    // garde-fou, le tick des 30s écrase le message en cours et le refresh a
    // l'air terminé alors qu'il tourne encore.
    if (busy) return;
    busy = true;
    refreshBtn.disabled = true;
    statusEl.classList.remove("err");
    statusEl.textContent = force ? "Actualisation en cours (peut prendre quelques secondes)…" : "Chargement…";
    try {
      const res = await fetch(force ? "/api/galactic/refresh" : "/api/galactic/status", { method: force ? "POST" : "GET" });
      const data = await res.json().catch(() => ({}));
      if (data.error || !res.ok) {
        statusEl.classList.add("err");
        statusEl.textContent = data.error || `Erreur HTTP ${res.status}`;
        return;
      }
      // Le serveur ne poll melee.gg que toutes les 5 min : 9 fois sur 10 les
      // données sont identiques, inutile de reconstruire tout le DOM (ça casse
      // la sélection de texte et ferait clignoter la carte pour rien).
      const token = `${data.lastPolled}|${data.lastError}`;
      if (token !== renderedToken) {
        render(data);
        renderedToken = token;
      }
      const errSuffix = data.lastError ? ` (dernière erreur melee.gg : ${data.lastError})` : "";
      statusEl.textContent = `Données : ${fmtAge(data.lastPolled)} (${fmtTime(data.lastPolled)})${errSuffix}`;
      const stale = !data.lastPolled || Date.now() - new Date(data.lastPolled) > 12 * 60000;
      statusEl.classList.toggle("err", stale || !!data.lastError);
    } catch (err) {
      statusEl.classList.add("err");
      statusEl.textContent = `Erreur : ${err.message}`;
    } finally {
      busy = false;
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener("click", () => refresh(true));
  refresh(false);
  // Cette boucle interroge seulement le cache local (data/galactic.json) —
  // aucun appel melee.gg supplémentaire ici, ça reste bon marché. Le vrai
  // rafraîchissement melee.gg (toutes les 5 min) tourne côté serveur. Tous les
  // onglets s'initialisent au chargement : inutile de tourner à vide quand la
  // fenêtre est en arrière-plan.
  setInterval(() => { if (!document.hidden) refresh(false); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });
};
