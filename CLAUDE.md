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

## Page Ultra : découpage selon le profil de rouleur (modèle FlyUltra)
- Réglage « Découpage des jours » : « Mon profil » (défaut) ou « Plage horaire » (ancien modèle vitesse plat + VAM + plage reprise/bivouac).
- « Mon profil » applique à un seul coureur le modèle de FlyUltra (simulateur d'arrivées d'ultra de l'utilisateur, calé sur 21 courses / ~3 000 traces ; spécification d'origine dans le zip FLYUltra, docs/MODELE.md) :
  - coût par segment `flyPrep` : pente lissée ±250 m bornée ±15 %, montée ×(1 + 18·g), descente ×max(0,70 ; 1 − 9·|g|) ; `rem` = coût restant ;
  - `flyProfileFrom` : vitesse équivalent plat vf = Σ coût / Σ temps de déplacement sur les longues sorties « route » (≥ 3 h ou ≥ 80 km), coût d'une sortie résumée = km + 18·D+ − min(9·D+, 0,15·km) ; rythme de voyage (heure de départ hors 1er jour, heure d'arrêt hors dernier jour, arrêts) sur les séjours d'au moins 2 jours à ≥ 50 km/jour ;
  - `flyRider` : position p dans un peloton Standard (vf = 27·(1 − 0,30·0,95·p)) → groupe ; stratégie Course : arrêts 0,01 + 0,23·0,95·p, sommeil min(12, 3,5 + 3,5·0,95·p) h (× temps de roulage / 60 h, plancher 60 %), entre 22 h et 2 h 30 après 12,5 + 6·(1 − p) h d'éveil, pas d'arrêt s'il reste < 6 h (25 % les plus rapides) ou < 3 h ; fatigue ×0,9 après 6 h, ×0,85 après 36 h. Stratégie Aventure : chaque nuit, de l'heure d'arrêt à l'heure de départ des voyages (à défaut 18 h 54 → 7 h 36), arrêts des voyages (à défaut 0,425), fatigue ×0,949 après 24 h, pas d'arrêt s'il reste < 4 h 38 ;
  - terrain Route ×1 / Mixte ×0,9 / Gravel ×0,8 sur vf. Le vent (option) s'applique en plus.
  - horaires de la stratégie modifiables (`#advStart`/`#advEnd` en Aventure, `#sleepStart`/`#sleepEnd` en Course) : pré-remplis avec les valeurs du profil (`fillStrategyTimes`) tant que l'utilisateur ne les change pas (`data-user`, `timeOverride`, enregistrés dans `pmr-opt-ultra`) ; en Course avec horaires choisis, on dort du coucher au réveil, après au moins min(8 h, A) d'éveil.
- Dans `simulate`, `opt.fly` remplace la vitesse/VAM/arrêts et la plage horaire ; les nuits sont des `stops` marqués `sleep: true`.

## Page Ultra : lieux le long de la trace
- Rayon `#poiRadius` (200 m → 2 km) : requête Overpass (overpass-api.de seul : les miroirs ne répondent plus aux navigateurs ; 90 s max par requête ; en cas de refus — limite de 4 requêtes simultanées, souvent sans en-tête CORS donc vue comme erreur réseau — on lit /api/status pour attendre un créneau libre, jusqu'à 6 essais ; recherche annulée si la trace ou le rayon change) avec `around` sur la trace simplifiée (Douglas-Peucker à rayon/5, portions de ≤ 25 km de trace et ≤ 80 points, coupées en deux si le serveur répond « runtime error / timed out », rayon interrogé = rayon + tolérance puis filtrage à l'écart réel). Deux requêtes à la fois, résultats affichés au fur et à mesure ; une portion en échec n'arrête pas les autres (pas de mise en cache si incomplet). Rattachement à la trace par index spatial (`routeGrid`, cases de 0,01°).
- Un GPX importé est d'abord simplifié comme à l'enregistrement (`unpackPts(packPts(...))`) : rouvrir le parcours redonne la même trace (même signature, même cache). Catégories et étiquettes dans `POI_GROUPS` / `POI_TYPES`.
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
