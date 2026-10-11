# Plan My Ride

Planifier une sortie vélo, de la boucle du dimanche au bikepacking sur plusieurs jours, à partir d'une trace GPX et des prévisions météo.

Importez un GPX, choisissez le jour et l'heure de départ : l'app estime l'heure de passage à chaque point du parcours et affiche la météo prévue à cet endroit et à cette heure-là.

## Fonctions

- **Horaires de passage** calculés depuis la vitesse sur le plat, la VAM en montée, un bonus en descente, un pourcentage d'arrêts et, en option, l'effet du vent.
- **Sorties sur plusieurs jours** : plage horaire de roulage, arrêt au bivouac, reprise le lendemain.
- **Météo le long du tracé** (Open-Meteo, jusqu'à 16 jours) : température et ressenti, pluie et probabilité, ciel, ensoleillement, nuit, vent et rafales.
- **Vent relatif** à la direction de route : face, dos ou travers.
- **Carte** colorée par vent, température, pluie ou soleil, avec flèches de vent. Fonds Plan, Clair et Relief.
- **Profil interactif** : altitude, température ressentie, pluie, bande de vent, nuit, heures.
- **Meilleure heure de départ** : comparaison des départs de 4 h à 16 h.
- **Feuille de route** exportable en CSV.

## Utilisation

Ouvrir `index.html` dans un navigateur, ou utiliser la version en ligne sur GitHub Pages. Aucune installation, aucune clé d'API.

## Structure

Un seul fichier, `index.html` : HTML, CSS et JavaScript sans build. Dépendance chargée par CDN : Leaflet 1.9.4.

## Crédits

- Météo : [Open-Meteo.com](https://open-meteo.com) (CC BY 4.0)
- Fonds de carte : © contributeurs OpenStreetMap, © CARTO, © OpenTopoMap (CC-BY-SA)
