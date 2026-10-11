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

## Modèle de vitesse
- montée : temps = distance / vitesse plat + D+ / VAM
- descente (pente < −1 %) : vitesse × (1 + (pente − 1 %) × 6), plafonné à ×1,35
- vent : facteur 1 − 0,012 × composante de face (km/h), borné [0,55 ; 1,35]
