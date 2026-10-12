# Plan My Ride — notes pour Claude Code

Application web statique de planification de sorties vélo : trace GPX + prévisions météo.

## Contraintes
- Tout tient dans `index.html` (pas de build, pas de framework). Garder ce choix sauf demande contraire.
- Déploiement : GitHub Pages depuis la branche `main`, racine du dépôt.
- Interface en français.
- Leaflet 1.9.4 via cdnjs. Fonds sans clé uniquement (CARTO exige désormais une clé) : OSM standard (seulement servi en http(s), il exige un Referer), CyclOSM, OpenTopoMap, Esri Topo/Satellite. En `file://`, le fond par défaut est Esri Topo.

## Architecture du script (dans `index.html`)
- `parseGPX` → `prepare` (distances cumulées, altitude lissée, D+/D− avec seuil 3 m, cap sur ~150 m)
- `makeSamples` : jusqu'à ~60 points d'échantillonnage pour la météo
- `fetchWeather` : un seul appel Open-Meteo multi-points, `timeformat=unixtime`, `timezone=GMT`
- `wxAt(k, t)` : interpolation horaire (direction du vent via composantes u/v)
- `simulate(t0, opt, useWx)` : temps de passage segment par segment (plat + VAM, descente, arrêts, vent, plage horaire multi-jours) + statistiques
- `score` : classement des heures de départ
- Rendu : `renderSummary`, `renderMap`, `renderChart` (canvas), `renderTable`, `renderOpts`
- `renderOpts` : deux lignes seulement, le départ choisi (« Ton départ ») et le meilleur créneau parmi les départs de 4 h à 16 h ; une seule ligne si c'est le même.
- Feuille de route : interrupteur « Afficher les lignes » (`#rowsOn`, mémorisé dans `localStorage` `pmr-rows`) ; l'export CSV reste complet.
- `renderWindArrows` : une flèche tous les `ARROW_GAP` (40 px) le long de la trace, seulement dans la zone visible, redessinée à chaque `moveend` ; météo du point d'échantillonnage le plus proche à l'heure de passage.

## Deux pages : Sortie et Ultra
- Onglets « Sortie » / « Ultra » dans l'en-tête ; la page Ultra a l'adresse `#ultra` (`S.mode`, `switchMode`, `applyModeUI`).
- Chaque page a ses réglages (`pmr-opt` / `pmr-opt-ultra`, défauts dans `MODE_DEF`) ; la page Ultra garde aussi la date de départ. Type de sorties de référence du calage par page (`pmr-calib-kind-ride` / `-ultra`, « voyage » par défaut en Ultra).
- Sortie : meilleure heure de départ (`#optCard`) et feuille de route (`#roadCard`). Ultra : plage de roulage multi-jours, rayon des ravitos, cartes « Jour par jour » (`renderDays`) et « Ravitaillement et hébergement » (`renderPois`). Le profil (`#chartCard`) est sur les deux.
- `renderDays` : un jour par arrêt de nuit de `simulate` (≥ 3 h) ; distance, D+ (`cumUp`), horaires, météo des points d'échantillonnage, hébergements à ±10 km du bivouac, dernier ravito ouvert avant, premier ravito ouvert le lendemain.

## Page Ultra : lieux le long de la trace
- Rayon `#poiRadius` (200 m → 2 km) : requête Overpass (overpass-api.de, repli overpass.kumi.systems) avec `around` sur la trace simplifiée (Douglas-Peucker, morceaux de 180 points). Catégories et étiquettes dans `POI_GROUPS` / `POI_TYPES`.
- Chaque lieu est rattaché au point de trace le plus proche (km, écart) ; l'heure de passage vient de `S.tl.times`. Horaires évalués avec opening_hours.js 3.15.0 (+ suncalc 1.9.0), chargés à la demande depuis jsDelivr.
- Résultats mis en cache 14 jours dans IndexedDB (store `pois`, clé = signature de la trace + rayon). Les marqueurs sont dans le volet Leaflet `poiPane` (au-dessus des flèches de vent).
- Tronçons sans ravitaillement (alimentation, restos, bars, stations) : le plus long en général, et ceux de plus de 30 km sans lieu ouvert au passage (les lieux sans horaires comptent comme possibles).

## Mes parcours (GPX gardés en mémoire)
- Chaque GPX chargé est enregistré (points simplifiés : un tous les ~5 m, `[lat, lon, ele]` à 5 décimales) dans IndexedDB (`pmr` : stores `meta` et `pts`) et, si l'utilisateur est connecté à Coach Miguel, dans la table Supabase `routes` (RLS par utilisateur) pour le retrouver sur ses autres appareils.
- Identifiant = empreinte du tracé (`routeId`) : recharger le même GPX ne crée pas de doublon. Le dernier parcours ouvert (`localStorage` `pmr-last-route`) se rouvre au démarrage. Au démarrage connecté, les parcours présents seulement dans le navigateur sont envoyés au compte ; ceux du compte sont téléchargés à l'ouverture.
- supabase-js n'est chargé au démarrage que si un jeton de session existe (`sb-rynbzhuxwvfvblgwnhkk-auth-token`).

## Ciel dans la feuille de route
- `wxAt` prend le code météo de la même heure que la pluie (l'heure qui se termine) ; un code pluie / bruine / neige / averses avec moins de 0,1 mm sur l'heure est remplacé par la couverture nuageuse.

## Calage sur l'historique (option « Caler sur mes sorties »)
- Lit la table `activities` du projet Supabase de Coach Miguel (même origine GitHub Pages, donc session de connexion partagée avec `coach.html`). supabase-js chargé à la demande.
- Sorties retenues : Ride / GravelRide / EBikeRide, hors home trainer, ≥ 10 km et ≥ 20 min, sur la période choisie ; l'utilisateur peut en décocher (exclusions dans `localStorage` `pmr-calib-excl`).
- `fitRides` : moindres carrés pondérés par la durée sur temps ≈ (D − 0,0039·D+)/v + D+/VAM (le terme 0,0039·D+ approche le gain de descente du modèle). Si la VAM sort de [300 ; 1400], elle est bornée et seule v est calée. Arrêts = médiane de (temps écoulé − temps de déplacement) / temps de déplacement.
- Choix « Vélo route » / « Voyage » (`classifyRides`) : chez soi = zone de départ la plus fréquente ; les sorties à plus de 80 km sont regroupées en séjours (≤ 3 jours d'écart) ; un séjour est « voyage » si le temps réel dépasse de 25 % ou plus celui prévu par le modèle calé sur les sorties à la maison. Reclassements manuels dans `localStorage` `pmr-calib-cat`, choix courant dans `pmr-calib-kind`. Les 12 derniers mois sont toujours lus ; la période ne filtre qu'ensuite.
- Quand l'option est active, les curseurs sont verrouillés et `pmr-opt` garde les réglages manuels, restaurés à la désactivation.

## Modèle de vitesse
- montée : temps = distance / vitesse plat + D+ / VAM
- descente (pente < −1 %) : vitesse × (1 + (pente − 1 %) × 6), plafonné à ×1,35
- vent : facteur 1 − 0,012 × composante de face (km/h), borné [0,55 ; 1,35]
