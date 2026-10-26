# Sillage — app iPhone et Android

Projet Capacitor qui embarque la page web (`../index.html`) dans une app native. Identifiant : **`cc.sillage.app`** (définitif dès la première publication). Version : 0.1.0.

La page web reste l'unique code de l'app : on la fait évoluer comme d'habitude (`test.html` puis `index.html`), puis on reconstruit l'app.

## Ce que contient ce dossier

| Élément | Rôle |
|---|---|
| `scripts/build-www.mjs` | Recopie `index.html` (ou `test.html` avec `--test`) dans `www/` en l'adaptant à l'app : polices et Leaflet embarqués (plus de CDN), pas de manifeste, pont natif, lien Admin et « Mot de passe oublié ? » renvoyés vers le site web. S'arrête si la page a changé à un endroit attendu. |
| `native/native.js` | Pont natif chargé avant le script de la page : partage des exports (image, CSV, GPX) par la feuille de partage du téléphone, bouton retour d'Android, couleur de la barre d'état selon le thème, ouverture des liens d'alerte. |
| `scripts/make-icon-sources.mjs` | Dessine en vectoriel l'icône (même dessin que `icons/sillage-512.png`) et l'écran de démarrage dans `assets/`. |
| `capacitor.config.json` | Nom, identifiant, couleurs, écran de démarrage. Adresse interne de l'app : `https://app.sillage-ride.eu` (Android) / `capacitor://app.sillage-ride.eu` (iPhone) — ne plus la changer : les parcours et la session gardés dans l'app en dépendent. |
| `android/`, `ios/` | Projets natifs à ouvrir dans Android Studio et Xcode. |

## Mettre à jour l'app après une évolution du site

```bash
cd app
npm install          # la première fois
npm run sync         # depuis index.html (version en ligne)
npm run sync:test    # ou depuis test.html (version d'essai)
```

Icône ou écran de démarrage modifiés : `npm run icons`.

## Lancer l'app sur un téléphone ou un simulateur (sur le Mac)

- **Android** : installer Android Studio, puis `npm run android` → bouton ▶ (émulateur ou téléphone branché en mode développeur).
- **iPhone** : installer Xcode (App Store), puis `npm run ios` → choisir un simulateur ou l'iPhone branché → ▶. La première fois, choisir son compte Apple dans *Signing & Capabilities*.

## Avant la publication

- Comptes développeur : Apple Developer Program et Google Play Console.
- Clé de signature Android (`.jks`) : créée dans Android Studio (*Build → Generate Signed Bundle*), gardée **hors du dépôt** (dépôt public) et sauvegardée — la perdre empêche de publier les mises à jour (sauf avec la signature gérée par Google Play, recommandée).
- Fiches des stores : captures d'écran, description, politique de confidentialité (adresse web), compte de démonstration pour les vérificateurs (l'accès est fermé au public).
- Apple : une app qui permet de créer un compte doit aussi permettre de le **supprimer depuis l'app** (règle 5.1.1) — à ajouter dans la page Moi.

## Reste à faire

- Notifications natives (alertes météo) : le Web Push du site ne marche pas dans l'app. Il faudra Firebase (Android) et une clé APNs (Apple), puis brancher la fonction `push-alerts`.
- Lien testeur et liens d'alerte qui ouvrent l'app (App Links / Universal Links sur sillage-ride.eu).
- Suppression du compte dans la page Moi (exigence Apple).
- Vérifier dans l'app : fond de carte OpenStreetMap (il exige une adresse d'origine), import d'un GPX depuis Fichiers / WhatsApp / Komoot, partage de l'export image, bouton retour Android, zones de l'encoche et de la barre de gestes.
