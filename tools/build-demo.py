#!/usr/bin/env python3
"""Fabrique la démo en accès libre (sillage-ride.eu/demo/) à partir de test.html.
Usage : python3 tools/build-demo.py ../sillage-site/demo
Copie test.html → index.html (drapeau window.SILLAGE_DEMO_WEB, sans manifeste, noindex),
lang.js, les traces demo/*.gpx et les icônes utilisées."""
import re, shutil, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root.parent / 'sillage-site' / 'demo').resolve()
s = (root / 'test.html').read_text(encoding='utf-8')
def sub(pat, rep, n=1):
    global s
    s, k = re.subn(pat, rep, s, count=n)
    if k != n: sys.exit('introuvable : ' + pat)
sub(r'<link rel="manifest"[^>]*>\s*', '')
sub(r'<head>', '<head>\n<script>window.SILLAGE_DEMO_WEB = true;</script>')
sub(r'<title>[^<]*</title>', '<title>Sillage · Démo en ligne</title>')
sub(r'<meta name="robots" content="noindex">', '<meta name="robots" content="index,follow">\n<meta name="description" content="Essaie Sillage en ligne : la météo sur ta trace, heure par heure, avec des parcours d\'exemple. Sans compte.">\n<link rel="canonical" href="https://sillage-ride.eu/demo/">')
shutil.rmtree(out, ignore_errors=True); (out / 'demo').mkdir(parents=True); (out / 'icons').mkdir()
(out / 'index.html').write_text(s, encoding='utf-8')
shutil.copy(root / 'lang.js', out / 'lang.js')
for f in (root / 'demo').glob('*.gpx'): shutil.copy(f, out / 'demo' / f.name)
for f in ('sillage-192.png', 'sillage-apple-touch-icon.png', 'sillage.svg'): shutil.copy(root / 'icons' / f, out / 'icons' / f)
print('démo écrite dans', out, sum(p.stat().st_size for p in out.rglob('*') if p.is_file()) // 1024, 'Ko')
