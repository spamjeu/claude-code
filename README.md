# SWU Card & Text Finder

Petit outil web (un seul fichier `index.html`, aucune dépendance, aucun build) pour
chercher des cartes *Star Wars: Unlimited* par **texte / mot-clé** plutôt que par leader.

Pensé au départ pour retrouver facilement les cartes liées au nouveau mécanisme
**Advantage** (jeton d'avantage temporaire, +1/+0, se défausse après la prochaine
attaque/défense de l'unité) introduit dans le set **Ashes of the Empire (ASH)** —
cf. par exemple [ASH/208](https://swudb.com/card/ASH/208) et
[ASH/253](https://swudb.com/card/ASH/253).

## Utilisation

L'API publique `api.swu-db.com` ne renvoie pas d'en-tête CORS sur ses réponses `GET`
(seul son preflight `OPTIONS` en annonce un) : un `fetch()` direct depuis un navigateur
est donc **toujours bloqué**, que ce soit ouvert en `file://` ou servi statiquement
(ex. `npx serve .`). Ce dépôt inclut un petit proxy Node (`server.js`, aucune dépendance)
qui relaie les requêtes côté serveur pour contourner ça :

```bash
node server.js
# puis ouvre http://localhost:8787
```

Aucune recherche ne se lance au chargement — saisis un texte ou choisis un filtre puis
lance la recherche. Tu peux :

- taper un texte libre dans le champ de recherche (il matche le nom **et** le texte de
  la carte côté API),
- filtrer par set (ASH / LOF / JTL — les sets antérieurs SOR/SHD/TWI sont dépréciés et
  volontairement absents du filtre) / type / aspect,
- utiliser les raccourcis liés au mécanisme Advantage ("Advantage (ASH)", "Advantage tous
  sets", "Upgrades ASH", "gain + advantage"),
- taper `raw:<requête>` pour passer directement une requête à la syntaxe complète de l'API
  (voir [swu-db.com/syntax](https://www.swu-db.com/syntax)).

Chaque résultat pointe vers sa page carte sur [swudb.com](https://swudb.com), et un
lien "JSON brut" est disponible pour déboguer si un champ ne s'affiche pas correctement.

## Base de decks locale (quels decks jouent une carte ?)

En bas de page, un panneau permet d'indexer localement des decks publiés sur
[swudb.com](https://swudb.com) (format Premier) pour ensuite chercher "quels decks
jouent la carte X" :

- **Importer / mettre à jour** appelle `POST /api/decks/sync` côté serveur, qui parcourt
  deux classements SWUDB — les decks Premier les plus "hot" (tendance) et les plus "top"
  (le classement de [swudb.com/decks/top](https://swudb.com/decks/top), tous-temps) —
  récupère le détail de chacun (liste de cartes incluse), et sauvegarde tout dans
  `data/decks.json` (créé automatiquement, ignoré par git). Rappelle le bouton plus tard
  pour agrandir/rafraîchir la base — les decks déjà connus sont mis à jour, pas dupliqués.
  Par défaut : 100 decks par classement (`limit`, plafonné à 500 côté serveur), soit
  jusqu'à 200 au total. Les decks "top" élargissent surtout la base utilisée par les
  suggestions de l'onglet Deck Builder (cf. plus bas), même quand ils datent d'anciens sets.
- **Chercher les decks** appelle `GET /api/decks/by-card?q=...` qui filtre
  `data/decks.json` localement (aucun appel réseau à ce moment-là) et liste les decks
  dont au moins une carte matche le nom tapé, avec un lien vers la page du deck sur
  SWUDB.

### Date de publication et filtre par période

La colonne "Publié" reprend le champ `publishDate` de swudb.com (déjà stocké
en base, aucun appel supplémentaire). Comme l'import "top" ratisse le
classement de tous les temps, la base mélange des decks récents et des decks
d'anciens sets : le filtre de dates sert surtout à isoler ce qui est
d'actualité.

- Deux bornes `du` / `au` (incluses), envoyées au serveur en `from` / `to`
  (`YYYY-MM-DD`) — toute autre forme est ignorée plutôt que de filtrer au
  hasard.
- Les raccourcis (7 / 30 / 90 derniers jours, depuis la sortie d'ASH) ne font
  que **remplir ces deux champs** : le filtre ne lit jamais qu'eux, donc
  modifier une date à la main bascule simplement l'étiquette sur
  "Personnalisé".
- Côté serveur, la comparaison se fait sur les 10 premiers caractères de la
  date ISO plutôt que via `Date()` : un deck publié en soirée UTC changerait
  sinon de jour selon le fuseau du serveur.
- Un tri "date (récents d'abord)" complète les tris existants.

### Prix estimé du deck (TCGPlayer, via swudb.com)

La colonne "Prix (TCGPlayer)" du tableau de decks reprend directement le champ
`priceDetail` déjà présent dans la réponse de l'API deck de swudb.com — aucun
appel réseau ni compte/clé supplémentaire nécessaire. C'est un prix indicatif
en **dollars** (source TCGPlayer, marketplace américain), pas un prix garanti
ni une conversion en euros. Le tableau affiche le "prix marché" ; le détail
(prix bas + prix marché) est visible en survolant la valeur.

## Classeur (onglet "Classeur")

Simule un classeur physique **9 pochettes par page** pour chaque extension, afin
de préparer le rangement de ses cartes. L'ordre suit celui du set, avec un saut
de page à chaque changement de groupe :

1. les **leaders**, puis
2. les **bases**, qui démarrent sur une nouvelle page, puis
3. **le reste des cartes** (unités / améliorations / événements), qui démarre
   également sur une nouvelle page.

Les pochettes restantes en fin de groupe sont affichées en pointillés, pour que
chaque page ait bien ses 9 emplacements comme dans un vrai classeur. Une seule
version de chaque carte est présentée (la version "Normal" — ni foil, ni
hyperspace, ni showcase, qui sont la même carte sous un autre numéro).

Côté serveur, `/api/cards/set?set=<code>` récupère le set via api.swu-db.com
(mis en cache pour la durée du process, le premier appel prend une dizaine de
secondes), le réduit aux seuls champs affichés et le **trie par numéro de
collection** : l'API amont, elle, trie par nom, donc sans ce tri le classeur
sortirait dans l'ordre alphabétique. La liste des extensions est partagée entre
les onglets via `window.SWU.SETS` (`js/common.js`), et validée côté serveur par
`KNOWN_SETS` (`server.js`).

## Suivi de tournoi melee.gg (onglet "Tournoi")

Cet onglet suit automatiquement une liste de pseudos (configurés en dur dans
`server.js`, constante `MELEE_TRACKED_PLAYERS`) à travers un ou plusieurs
tournois melee.gg (constante `MELEE_TOURNAMENTS`, une liste `{ id, label }` —
chaque tournoi est autonome, pas besoin qu'ils appartiennent à un même Hub) :
classement, round en cours, adversaire, table. Actuellement suivi : le
[PQ Strasbourg (Philibert)](https://melee.gg/Tournament/View/443936) du
01/08/2026.

L'affichage est en **deux colonnes** sur écran large (≥ 900px) :

- à gauche, une **échelle unique** — une ligne par joueur suivi, triée par rang
  melee.gg, plutôt qu'une carte par joueur (avec plusieurs pseudos dans un même
  tournoi, l'intérêt est de les comparer entre eux). Chaque ligne montre le
  rang, le pseudo, son parcours sous forme de pastilles — 🟩 victoire, 🟦 nulle,
  🟥 défaite, contour clignotant pour la ronde en cours — et son record ;
- à droite, un panneau collant : par défaut l'état des tournois suivis (lien
  melee.gg, statut, effectif) et le bilan cumulé des pseudos ; en cliquant un
  pseudo, le détail de ce joueur (classement complet, puis chaque match avec
  adversaire, rang de l'adversaire, table et score). Recliquer la même ligne
  (ou le ✕) revient à la vue d'ensemble.

En dessous de 900px, tout repasse sur une colonne : le panneau de détail se
place sous l'échelle, et un clic scrolle jusqu'à lui.

- melee.gg n'a pas d'API publique documentée et ne renvoie pas d'en-tête CORS
  non plus — mêmes symptômes que api.swu-db.com, donc même traitement : un
  relais côté `server.js`. Ses endpoints internes ont été retrouvés en
  inspectant son JS (`/Standing/GetRoundStandings/{roundId}`,
  `/Match/GetRoundMatches/{roundId}`). Nom, statut et effectif d'un tournoi
  ne sont exposés par aucun endpoint JSON pris isolément : ils sont lus
  directement sur la page HTML du tournoi (`extractTournamentHeadline`).
- melee.gg protège ces endpoints avec un WAF qui **bloque temporairement
  l'IP appelante** après une poignée de requêtes rapprochées (constaté en
  marge de l'implémentation). Le serveur ne rafraîchit donc que **toutes les
  5 minutes**, en série, avec un vrai délai entre chaque requête — et saute
  entièrement les tournois encore en phase d'inscription (aucun round posté)
  pour limiter le nombre d'appels, et arrête complètement d'interroger un
  tournoi une fois son instantané final mis en cache. C'est volontairement
  lent : le but est de ne jamais risquer de bloquer ta propre connexion
  pendant que tu suis l'événement en direct dans ton navigateur.
- Les résultats sont mis en cache dans `data/galactic.json` (créé
  automatiquement, ignoré par git). Le bouton "Forcer une actualisation"
  déclenche un cycle immédiat plutôt que d'attendre les 5 minutes.
- Pseudos suivis : `Pecoraban`, `Fred57155`, `Malette`, `Liryos`, `Mario57`,
  `ftdm57`, `LorN_Leonidas`, `Bibam` — à ajuster dans `MELEE_TRACKED_PLAYERS`
  si besoin (matching en sous-chaîne insensible à la casse sur le username et
  le nom affiché).

## Données

- Les cartes viennent de l'API publique et non-officielle
  [api.swu-db.com](https://www.swu-db.com/api) (endpoint `/cards/search`), relayée par
  le petit proxy local `server.js` — rien ne transite par un serveur tiers, seul ton
  poste appelle l'API.
- Les decks viennent de l'API **interne et non documentée** de swudb.com
  (`/api/decks/search` et `/api/deck/{id}`), découverte en inspectant son bundle JS
  public. Elle ne nécessite pas d'authentification pour lire des decks publiés, mais
  n'est pas garantie stable dans le temps (peut changer sans préavis). L'import est
  volontairement limité (max 500 decks par appel, ~200ms de délai entre requêtes) pour
  rester raisonnable envers leur serveur.

Pour des stats de méta plus larges (sans devoir importer toi-même) :

- [SWU Meta Stats — Meta Premier (Ashes of the Empire)](https://www.swumetastats.com/meta/overview?format=Premier&meta=ashes-of-the-empire)

## Limites connues

- La base de decks est **locale et manuelle** : elle ne contient que ce que tu as
  importé via le bouton, pas l'intégralité des decks publiés sur SWUDB.
- Le mapping des champs JSON (`Name`, `Text`, image, etc.) est fait de façon tolérante
  (recherche de clés approchantes) car le schéma exact de l'API cartes n'est pas
  garanti stable ; si un champ manque, regarde le "JSON brut" du résultat concerné.
- L'onglet Classeur regroupe les cartes sur le champ `Type` de l'API (`Leader`,
  `Base`, puis le reste) : si l'API renommait ces valeurs, tout se retrouverait
  dans le groupe "Cartes" sans erreur visible.
