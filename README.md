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
  les decks Premier les plus récents de SWUDB, récupère le détail de chacun (liste de
  cartes incluse), et sauvegarde tout dans `data/decks.json` (créé automatiquement,
  ignoré par git). Rappelle le bouton plus tard pour agrandir/rafraîchir la base — les
  decks déjà connus sont mis à jour, pas dupliqués. Par défaut : les 100 decks Premier
  les plus récents (`limit`, plafonné à 500 côté serveur).
- **Chercher les decks** appelle `GET /api/decks/by-card?q=...` qui filtre
  `data/decks.json` localement (aucun appel réseau à ce moment-là) et liste les decks
  dont au moins une carte matche le nom tapé, avec un lien vers la page du deck sur
  SWUDB.

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
