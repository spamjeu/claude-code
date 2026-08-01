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

  function record(matches) {
    const tally = { win: 0, loss: 0, draw: 0 };
    (matches || []).forEach((m) => { if (tally[m.outcome] != null) tally[m.outcome]++; });
    return `${tally.win}-${tally.loss}-${tally.draw}`;
  }

  const OUTCOME_LABELS = { win: "Victoire", loss: "Défaite", draw: "Nulle", pending: "En cours" };

  // La suite de pastilles vert/bleu/rouge est le seul endroit où le parcours
  // d'un joueur se lit sans déplier : une pastille par ronde jouée, dans
  // l'ordre, avec le détail (adversaire + score) en infobulle.
  function pipsHtml(matches) {
    return (matches || []).map((m) => {
      const outcome = m.outcome || "pending";
      const opponents = (m.opponents || []).map((o) => o.name).join(", ") || "bye";
      const score = m.score || OUTCOME_LABELS[outcome] || "";
      return `<span class="gal-pip gal-pip-${esc(outcome)}" title="${esc(`${m.roundName} — vs ${opponents} — ${score}`)}"></span>`;
    }).join("");
  }

  // Data auto-refreshes every 30s; without this, a manual expand/collapse
  // click would get silently undone by the next refresh.
  const collapsedOverrides = {};

  function occurrenceBodyHtml({ standing, matches }) {
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
    return parts.join("") || `<div class="status">Aucun détail disponible pour l'instant.</div>`;
  }

  // Une ligne de l'échelle = un joueur dans un tournoi. Repliée, elle tient le
  // rang, le pseudo et le parcours ; dépliée, elle montre le détail des matchs.
  function renderRow(occ, showEvent) {
    const { name, tournamentId, tournamentLabel, standing, matches, isFinished, playerOut } = occ;
    const li = document.createElement("li");
    li.className = "gal-row";

    const live = (matches || []).find((m) => m.outcome === "pending");
    if (live) li.classList.add("gal-row-live");
    const dropLabel = standing && standing.isActive === false
      ? (DROP_LABELS[standing.status] || standing.status || "Abandon")
      : (playerOut && !isFinished ? "Éliminé" : null);
    if (dropLabel) li.classList.add("gal-row-out");

    // Clé sur l'id : melee.gg renomme parfois un tournoi en cours de route.
    const overrideKey = `${name}::${tournamentId}`;
    const collapsed = Object.hasOwn(collapsedOverrides, overrideKey) ? collapsedOverrides[overrideKey] : true;
    if (collapsed) li.classList.add("collapsed");
    li.dataset.overrideKey = overrideKey;

    const rank = standing && standing.rank != null ? `#${esc(standing.rank)}` : "—";
    const status = live
      ? `<span class="gal-live" title="${esc(live.roundName)}">● ${esc(live.roundName)}</span>`
      : (dropLabel ? `<span class="gal-out" title="${esc((standing && standing.status) || "")}">${esc(dropLabel)}</span>` : "");
    const event = showEvent ? `<span class="gal-row-event" title="${esc(tournamentLabel)}">${esc(tournamentLabel)}</span>` : "";

    li.innerHTML = `
      <button type="button" class="gal-row-head" aria-expanded="${!collapsed}">
        <span class="gal-tournament-toggle">▾</span>
        <span class="gal-row-rank">${rank}</span>
        <span class="gal-row-name">${esc(name)}${event}</span>
        <span class="gal-pips">${pipsHtml(matches)}</span>
        <span class="gal-row-record">${esc(record(matches))}</span>
        <span class="gal-row-status">${status}</span>
      </button>
      <div class="gal-row-body">${occurrenceBodyHtml(occ)}</div>`;

    const head = li.querySelector(".gal-row-head");
    head.addEventListener("click", () => {
      const nowCollapsed = li.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", String(!nowCollapsed));
      collapsedOverrides[overrideKey] = nowCollapsed;
    });
    return li;
  }

  function renderMissingRow(name) {
    const li = document.createElement("li");
    li.className = "gal-row gal-row-missing";
    // Mêmes 6 cases que les autres lignes, sinon le pseudo ne s'aligne plus
    // sur la colonne des pseudos.
    li.innerHTML = `<div class="gal-row-head">
      <span class="gal-tournament-toggle"></span>
      <span class="gal-row-rank">—</span>
      <span class="gal-row-name">${esc(name)}</span>
      <span class="gal-pips"></span>
      <span class="gal-row-record"></span>
      <span class="gal-row-status">Pas encore repéré</span>
    </div>`;
    return li;
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

    // Une seule échelle plutôt qu'une carte par joueur : avec plusieurs pseudos
    // suivis dans un même tournoi, ce qui intéresse est de les comparer entre
    // eux, pas de lire sept fois le même nom de tournoi.
    const occurrences = [];
    const missing = [];
    trackedPlayers.forEach((name) => {
      const found = tournaments
        .filter((t) => t.players && t.players[name])
        .map((t) => ({
          name,
          tournamentId: t.id,
          tournamentLabel: t.name || t.label,
          isFinished: isEventFinished(t),
          rounds: t.rounds,
          ...t.players[name],
        }))
        .map((occ) => ({ ...occ, playerOut: isPlayerOut(occ) }));
      if (found.length) occurrences.push(...found);
      else missing.push(name);
    });
    if (occurrences.some((o) => (o.matches || []).some((m) => m.outcome === "pending"))) anyLive = true;

    // Tournoi en cours d'abord, puis rang croissant : un joueur sans classement
    // publié (ronde 1 non terminée) finit en bas plutôt qu'en tête.
    const rankOf = (o) => (o.standing && o.standing.rank != null ? o.standing.rank : Infinity);
    occurrences.sort((a, b) => a.isFinished - b.isFinished || rankOf(a) - rankOf(b) || a.name.localeCompare(b.name));
    // Le nom du tournoi n'est utile sur chaque ligne que s'il y en a plusieurs.
    const showEvent = new Set(occurrences.map((o) => o.tournamentId)).size > 1;

    const board = document.createElement("ol");
    board.className = "gal-board";
    occurrences.forEach((occ) => {
      const row = renderRow(occ, showEvent);
      // Le rendu n'a lieu que sur données réellement neuves (cf. refresh) :
      // un flash discret rend le changement visible sans avoir à comparer.
      if (!firstRender) {
        row.classList.add("gal-updated");
        setTimeout(() => row.classList.remove("gal-updated"), 2000);
      }
      board.appendChild(row);
    });
    missing.forEach((name) => board.appendChild(renderMissingRow(name)));

    playersEl.innerHTML = "";
    playersEl.appendChild(board);
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
