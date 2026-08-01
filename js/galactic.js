window.SWU_TABS = window.SWU_TABS || {};

window.SWU_TABS.galactic = function initGalactic() {
  const playersEl = document.getElementById("galPlayers");
  const detailEl = document.getElementById("galDetail");
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

  // Le bilan affiché est celui que melee.gg publie (MatchRecord du classement),
  // pas un recomptage maison : melee classe sur la dernière ronde *terminée*
  // alors que les appariements de la ronde suivante sont déjà connus, donc
  // recompter depuis les matchs donne en permanence un bilan en avance d'une
  // ronde sur la page melee (et suppose qu'on interprète bien chaque libellé
  // de résultat). On ne recompte que faute de classement publié (ronde 1).
  function recordOf(occ) {
    return (occ.standing && occ.standing.matchRecord) || record(occ.matches);
  }

  function parseRecord(str) {
    const [win, loss, draw] = String(str || "").split("-").map((n) => parseInt(n, 10) || 0);
    return { win, loss, draw };
  }

  function totalRecord(occurrences) {
    const total = occurrences.reduce((acc, occ) => {
      const r = parseRecord(recordOf(occ));
      return { win: acc.win + r.win, loss: acc.loss + r.loss, draw: acc.draw + r.draw };
    }, { win: 0, loss: 0, draw: 0 });
    return `${total.win}-${total.loss}-${total.draw}`;
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

  // Le joueur ouvert dans le panneau de droite, sous la forme "pseudo::idTournoi".
  // Les données se rafraîchissent toutes les 30s : sans cet état conservé hors
  // du DOM, chaque refresh refermerait le détail en cours de lecture.
  let selectedKey = null;

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

  function dropLabelOf({ standing, isFinished, playerOut }) {
    if (standing && standing.isActive === false) {
      return DROP_LABELS[standing.status] || standing.status || "Abandon";
    }
    return playerOut && !isFinished ? "Éliminé" : null;
  }

  function occurrenceKey(occ) {
    // Clé sur l'id : melee.gg renomme parfois un tournoi en cours de route.
    return `${occ.name}::${occ.tournamentId}`;
  }

  // Une ligne de l'échelle = un joueur dans un tournoi : rang, pseudo, parcours
  // et record. Le détail, lui, s'ouvre dans le panneau de droite (cf. onSelect).
  function renderRow(occ, showEvent, onSelect) {
    const { name, tournamentLabel, standing, matches } = occ;
    const li = document.createElement("li");
    li.className = "gal-row";

    const live = (matches || []).find((m) => m.outcome === "pending");
    if (live) li.classList.add("gal-row-live");
    const dropLabel = dropLabelOf(occ);
    if (dropLabel) li.classList.add("gal-row-out");

    const key = occurrenceKey(occ);
    const selected = key === selectedKey;
    if (selected) li.classList.add("gal-row-selected");

    const rank = standing && standing.rank != null ? `#${esc(standing.rank)}` : "—";
    const status = live
      ? `<span class="gal-live" title="${esc(live.roundName)}">● ${esc(live.roundName)}</span>`
      : (dropLabel ? `<span class="gal-out" title="${esc((standing && standing.status) || "")}">${esc(dropLabel)}</span>` : "");
    const event = showEvent ? `<span class="gal-row-event" title="${esc(tournamentLabel)}">${esc(tournamentLabel)}</span>` : "";
    // Les pastilles peuvent montrer une ronde de plus que le bilan (résultat
    // connu, classement pas encore publié) : dire sur quelle ronde il porte.
    const recordTitle = standing && standing.roundName
      ? ` title="${esc(`Bilan melee.gg — ${standing.roundName}`)}"` : "";

    li.innerHTML = `
      <button type="button" class="gal-row-head" aria-pressed="${selected}">
        <span class="gal-tournament-toggle">›</span>
        <span class="gal-row-rank">${rank}</span>
        <span class="gal-row-name">${esc(name)}${event}</span>
        <span class="gal-pips">${pipsHtml(matches)}</span>
        <span class="gal-row-record"${recordTitle}>${esc(recordOf(occ))}</span>
        <span class="gal-row-status">${status}</span>
      </button>`;

    // Recliquer sur la ligne ouverte referme le détail (retour à la vue tournoi).
    li.querySelector(".gal-row-head").addEventListener("click", () => onSelect(selected ? null : key));
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

  // Le panneau de droite quand aucun joueur n'est sélectionné : l'état des
  // tournois suivis (avec leur lien melee.gg) et le bilan cumulé des pseudos.
  function overviewHtml(tournaments, occurrences, missingCount) {
    const rows = tournaments.map((t) => {
      const cls = t.status === "error" ? "bad" : t.status === "started" ? "live" : "";
      const label = t.status === "error" ? "erreur" : esc(FR_STATUS[t.statusDescription] || t.statusDescription || t.status);
      // Message d'erreur melee.gg en title : inline, il casserait la mise en page.
      const title = t.error ? ` title="${esc(t.error)}"` : "";
      const count = t.playerCount != null ? `<span class="gal-hub-count">${esc(t.playerCount)} joueurs</span>` : "";
      const rounds = t.rounds ? `<div class="hint">Ronde ${esc(t.rounds)}</div>` : "";
      return `<div class="gal-hub-row">
        <a href="https://melee.gg/Tournament/View/${esc(t.id)}" target="_blank" rel="noopener">${esc(t.name || t.label)}</a>
        <span class="badge ${cls}"${title}>${label}</span>${count}
      </div>${rounds}`;
    }).join("") || "En attente de la première actualisation…";

    const best = occurrences.find((o) => o.standing && o.standing.rank != null);
    const stats = occurrences.length ? `
      <div class="gal-stats" style="margin-top:12px">
        <div class="gal-stat"><div class="gal-stat-value">${esc(occurrences.length)}</div><div class="gal-stat-label">Suivis</div></div>
        <div class="gal-stat"><div class="gal-stat-value">${best ? `#${esc(best.standing.rank)}` : "—"}</div><div class="gal-stat-label">Meilleur rang</div></div>
        <div class="gal-stat"><div class="gal-stat-value">${esc(totalRecord(occurrences))}</div><div class="gal-stat-label">Bilan cumulé</div></div>
      </div>` : "";
    const absent = missingCount
      ? `<p class="hint" style="margin-top:10px">${missingCount} pseudo${missingCount > 1 ? "s" : ""} pas encore repéré${missingCount > 1 ? "s" : ""} dans le tournoi.</p>`
      : "";

    return `<div class="gal-detail-head"><strong>Tournois suivis</strong></div>
      ${rows}${stats}${absent}
      <p class="hint" style="margin-top:12px">👈 Clique sur un pseudo pour voir le détail de ses matchs.</p>`;
  }

  function detailHtml(occ) {
    const live = (occ.matches || []).find((m) => m.outcome === "pending");
    const dropLabel = dropLabelOf(occ);
    const status = live
      ? `<span class="gal-live">● ${esc(live.roundName)}</span>`
      : (dropLabel ? `<span class="gal-out">${esc(dropLabel)}</span>` : "");
    return `<div class="gal-detail-head">
        <div>
          <strong>${esc(occ.name)}</strong> ${status}
          <div class="hint">
            <a href="https://melee.gg/Tournament/View/${esc(occ.tournamentId)}" target="_blank" rel="noopener">${esc(occ.tournamentLabel)}</a>
          </div>
        </div>
        <button type="button" class="gal-detail-close" title="Fermer le détail" aria-label="Fermer le détail">✕</button>
      </div>
      ${occurrenceBodyHtml(occ)}`;
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

    // Un joueur sélectionné puis disparu des données (tournoi purgé, pseudo
    // retiré du suivi) doit rendre la main à la vue d'ensemble, pas laisser un
    // panneau vide.
    if (selectedKey && !occurrences.some((o) => occurrenceKey(o) === selectedKey)) selectedKey = null;

    // flash: seulement quand les données ont bougé. Sélectionner un joueur
    // redessine aussi l'échelle, mais faire clignoter les lignes à chaque clic
    // est juste pénible — et le flash ne voudrait plus rien dire.
    const drawBoard = (flash) => {
      const board = document.createElement("ol");
      board.className = "gal-board";
      occurrences.forEach((occ) => {
        const row = renderRow(occ, showEvent, select);
        if (flash) {
          row.classList.add("gal-updated");
          setTimeout(() => row.classList.remove("gal-updated"), 2000);
        }
        board.appendChild(row);
      });
      missing.forEach((name) => board.appendChild(renderMissingRow(name)));
      playersEl.innerHTML = "";
      playersEl.appendChild(board);
    };

    const drawDetail = () => {
      const occ = occurrences.find((o) => occurrenceKey(o) === selectedKey);
      detailEl.innerHTML = occ ? detailHtml(occ) : overviewHtml(tournaments, occurrences, missing.length);
      const close = detailEl.querySelector(".gal-detail-close");
      if (close) close.addEventListener("click", () => select(null));
    };

    function select(key) {
      selectedKey = key;
      drawBoard(false);
      drawDetail();
      // En une colonne (mobile), le panneau est sous l'échelle : sans ça, un
      // clic semble ne rien faire puisque le détail s'ouvre hors écran.
      if (key && window.matchMedia("(max-width:899px)").matches) {
        detailEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }

    drawBoard(!firstRender);
    drawDetail();
    firstRender = false;
    document.title = anyLive ? `🔴 ${baseTitle}` : baseTitle;
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
