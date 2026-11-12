#!/usr/bin/env python3
"""Pack de points utiles d'un pays pour Sillage.

Lit la sortie de `osmium export -f geojsonseq` (points et polygones déjà filtrés
par `osmium tags-filter`, voir filter.txt) et écrit un fichier NDJSON compressé :
une ligne par point, mêmes champs que la table Supabase `osm_poi` :
  {"id": "node/123", "type": "fontaine", "name": "…", "lat": 48.1, "lon": 7.7, "t": {…}}

Les types reprennent ceux de l'app : pmClassify (Carte des points) puis les types
ajoutés pour la page Ultra (carburant, hebergement, pharmacie, commerce).

Utilisation : build.py <entrée.geojsonseq> <sortie.ndjson.gz> <code-pays>
Affiche à la fin une ligne JSON de résumé (nombre de points par type).
"""
import gzip
import json
import re
import sys

KEEP = ("name", "opening_hours", "drinking_water", "website", "phone", "contact:phone", "contact:website",
        "addr:street", "addr:housenumber", "addr:postcode", "addr:city", "backcountry", "camp_site",
        "shelter_type", "bicycle", "fee", "access", "seasonal", "capacity", "cuisine", "brand",
        "amenity", "shop", "tourism", "man_made")


def classify(t):
    a, s, tr = t.get("amenity", ""), t.get("shop", ""), t.get("tourism", "")
    # Carte des points (pmClassify dans test.html)
    if a in ("drinking_water", "water_point") or ((a == "fountain" or t.get("man_made") == "water_tap") and t.get("drinking_water") == "yes"):
        return "fontaine"
    if s in ("bakery", "pastry"):
        return "boulangerie"
    if re.fullmatch(r"convenience|supermarket|general|greengrocer|farm", s):
        return "epicerie"
    if tr in ("camp_site", "camp_pitch"):
        return "bivouac"
    if tr in ("wilderness_hut", "alpine_hut") or (a == "shelter" and not re.search(r"public_transport|parking|field", t.get("shelter_type", ""))):
        return "abri"
    if re.fullmatch(r"cafe|restaurant|fast_food|pub|bar", a):
        return "cafe"
    if s == "bicycle" or a == "bicycle_repair_station":
        return "atelier"
    if a == "device_charging_station" or (a == "charging_station" and t.get("bicycle") in ("yes", "designated")):
        return "recharge"
    # Types en plus pour la page Ultra (osm_web_put2)
    if a == "fuel":
        return "carburant"
    if tr in ("hotel", "motel", "hostel", "guest_house", "chalet"):
        return "hebergement"
    if a == "pharmacy":
        return "pharmacie"
    if s in ("butcher", "deli", "kiosk") or a == "biergarten":
        return "commerce"
    return None


def center(g):
    """Point pour un point, moyenne des sommets de l'anneau extérieur pour un polygone."""
    typ, c = g.get("type"), g.get("coordinates")
    if typ == "Point":
        return c[1], c[0]
    if typ == "Polygon":
        ring = c[0]
    elif typ == "MultiPolygon":
        ring = max((p[0] for p in c), key=len)
    elif typ == "LineString":
        ring = c
    else:
        return None
    if not ring:
        return None
    ring = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    return sum(p[1] for p in ring) / len(ring), sum(p[0] for p in ring) / len(ring)


def main(src, dst, cc):
    seen, count = set(), {}
    with open(src, encoding="utf-8") as f, gzip.open(dst, "wt", encoding="utf-8", compresslevel=9) as out:
        for line in f:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            feat = json.loads(line)
            tags = feat.get("properties") or {}
            typ = classify(tags)
            if not typ:
                continue
            osm_type = tags.get("@type") or feat.get("id", "").split("/")[0] or "node"
            osm_id = tags.get("@id") or feat.get("id", "").split("/")[-1]
            if osm_type == "area":  # osmium donne « area » pour les polygones : on garde l'objet d'origine
                n = int(osm_id)
                osm_type, osm_id = ("way", n // 2) if n % 2 == 0 else ("relation", n // 2)
            key = f"{osm_type}/{osm_id}"
            if key in seen:
                continue
            ll = center(feat.get("geometry") or {})
            if not ll:
                continue
            seen.add(key)
            t = {k: v for k, v in tags.items() if k in KEEP}
            row = {"id": key, "type": typ, "name": tags.get("name") or None,
                   "lat": round(ll[0], 6), "lon": round(ll[1], 6), "t": t, "cc": cc}
            out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            count[typ] = count.get(typ, 0) + 1
    print(json.dumps({"cc": cc, "total": sum(count.values()), "types": count}, ensure_ascii=False))


if __name__ == "__main__":
    main(*sys.argv[1:4])
