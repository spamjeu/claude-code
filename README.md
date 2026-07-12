# SWU Card & Text Finder

Petit outil web (un seul fichier `index.html`, aucune dépendance, aucun build) pour
chercher des cartes *Star Wars: Unlimited* par **texte / mot-clé** plutôt que par leader.

Pensé au départ pour retrouver facilement les cartes liées au nouveau mécanisme
**Advantage** (jeton d'avantage temporaire, +1/+0, se défausse après la prochaine
attaque/défense de l'unité) introduit dans le set **Ashes of the Empire (ASH)** —
cf. par exemple [ASH/208](https://swudb.com/card/ASH/208) et
[ASH/253](https://swudb.com/card/ASH/253).

## Utilisation

Ouvre simplement `index.html` dans un navigateur (double-clic), ou sers-le en local :

```bash
npx serve .
# puis ouvre l'URL affichée
```

La recherche par défaut au chargement montre toutes les cartes du set ASH dont le
texte mentionne "advantage". Tu peux ensuite :

- taper un texte libre dans le champ de recherche (il est transformé en `t:"..."` côté API),
- filtrer par set / type / aspect,
- utiliser les raccourcis ("Advantage (ASH)", "Advantage tous sets", "Upgrades ASH", "gain + advantage"),
- taper `raw:<requête>` pour passer directement une requête à la syntaxe complète de l'API
  (voir [swu-db.com/syntax](https://www.swu-db.com/syntax)).

Chaque résultat pointe vers sa page carte sur [swudb.com](https://swudb.com), et un
lien "JSON brut" est disponible pour déboguer si un champ ne s'affiche pas correctement.

## Données

Les cartes viennent de l'API publique et non-officielle
[api.swu-db.com](https://www.swu-db.com/api) (endpoint `/cards/search`), interrogée
directement depuis le navigateur — rien ne transite par un serveur tiers.

Pour croiser les cartes trouvées avec des listes de decks jouées en tournoi :

- [SWUDB — Decks du moment](https://swudb.com/decks/hot)
- [SWU Meta Stats — Meta Premier (Ashes of the Empire)](https://www.swumetastats.com/meta/overview?format=Premier&meta=ashes-of-the-empire)

## Limites connues

- L'outil cherche des **cartes**, pas directement des **decks** — la construction de
  decks (swudb.com) n'expose pas d'API publique documentée pour filtrer des decks par
  carte jouée ; ouvre la page carte correspondante sur SWUDB (souvent listée avec les
  decks qui l'utilisent) ou les liens meta ci-dessus pour aller plus loin.
- Le mapping des champs JSON (`Name`, `Text`, image, etc.) est fait de façon tolérante
  (recherche de clés approchantes) car le schéma exact de l'API n'est pas garanti stable ;
  si un champ manque, regarde le "JSON brut" du résultat concerné.
