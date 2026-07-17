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

### Prix estimé du deck (optionnel, CardTrader)

La colonne "Prix" du tableau de decks affiche une estimation du coût du deck via
l'API de [CardTrader](https://www.cardtrader.com) (marketplace européen, prix en EUR).
Pour l'activer :

1. Crée un compte gratuit sur cardtrader.com.
2. Récupère un token dans les paramètres de ton profil (Bearer token).
3. Crée un fichier `.env` à la racine du projet (ignoré par git) avec :
   ```
   CARDTRADER_TOKEN=ton_token_ici
   ```
4. Relance `node server.js`.

Sans ce token, la colonne "Prix" affiche simplement "—" (le reste de l'outil
fonctionne normalement). Le prix retenu par carte est le moins cher parmi les
annonces non-foil, non signées/altérées, en état Near Mint ou Slightly Played,
toutes langues confondues — c'est une estimation basse ("combien ça coûterait de
réunir ce deck en bon état"), hors frais de port, pas un prix garanti. Un `~`
devant le total signifie qu'au moins une carte du deck n'a pas d'annonce
correspondante sur CardTrader (deck partiellement pricé).

Le serveur construit un catalogue local (`data/cardtrader-catalog.json`, sets
principaux uniquement) et un index de prix (`data/prices.json`, uniquement pour
les cartes réellement utilisées par des decks synchronisés localement) —
tous deux créés automatiquement, ignorés par git, rafraîchis en tâche de fond
(catalogue : ~1x/jour, prix : ~1x/2h) indépendamment du bouton "Importer".

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
