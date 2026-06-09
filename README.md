# SKS Trainer

**Live:** https://gorki1905.github.io/sks-trainer/

Offline-fähige Lern-App (PWA) für die **SKS-Theorieprüfung** – Karteikarten mit
Spaced-Repetition, Prüfungssimulation mit getippter Antwort + automatischer
Kernpunkt-Prüfung, Erklärungen und Lernkurve. Läuft am PC und auf dem iPhone.

## Nutzung

- **Lokal/PC:** `docs/index.html` im Browser öffnen.
- **Online/iPhone:** Über GitHub Pages (`Settings → Pages → Branch: main, Ordner: /docs`).
  Im iPhone-Safari die Pages-URL öffnen → Teilen → „Zum Home-Bildschirm" = App-Icon, offline nutzbar.

## Funktionen

- **Lernen** – Karteikarten, Leitner-Boxen (1–5). Modi: *Fällig*, *Wichtigste*, *Schwächen*.
  Kurzantwort + vollständige Musterantwort + Erklärung.
- **Prüfung** – voller Bogen (30 Fragen → /60, bestehen ab 39, mündlich ab 33),
  Schnelltest (5), Schwächen-Test. Antwort eintippen → automatische Bewertung über
  hinterlegte **Kernpunkte/Synonyme** (Treffer/Lücken, 0/1/2-Vorschlag, manuell überschreibbar).
- **Bögen** – alle 15 Bögen durchblättern.
- **Auto** – Audio-Modus fürs Autofahren: Querformat-Vollbild, große Buttons, liest
  Frage + Kurzantwort vor (Button für volle Musterantwort), Leitner-Bewertung per
  großen Buttons oder – wenn das Gerät es unterstützt – per Sprachbefehl
  („gewusst" / „nicht" / „weiter" / „antwort"). Wake-Lock hält den Bildschirm an.
- **Status** – Fortschritt, Box-Verteilung, **Lernkurve** (14 Tage).
- **Sync** – manueller Upload/Download des Fortschritts über einen privaten GitHub-Gist
  (Token nur lokal im Browser gespeichert, nie im Repo).

## Daten neu bauen

```bash
# 1) Fragen + Musterantworten aus dem PDF parsen  (erzeugt sks_questions.json)
uv run --with pymupdf python3 parse_sks.py
# 2) Zusatzinhalte (Kurzantwort/Erklärung/Kernpunkte) liegen in enrich/output/
# 3) Zusammenführen -> docs/data.js + docs/data.json
python3 build_data.py
# 4) Icons (optional neu)
uv run --with pillow python3 gen_icons.py
```

## Struktur

```
docs/            # die App (GitHub Pages)
  index.html app.js styles.css data.js sw.js manifest.webmanifest icons/
enrich/          # Quell-Inhalte (input/ = Fragen, output/ = generierte Zusatzinhalte, SPEC.md)
parse_sks.py     # PDF -> sks_questions.json
build_data.py    # merge -> docs/data.js
gen_icons.py     # PWA-Icons
sks_questions.json
```

Hinweis: Das Quell-PDF (`SKS-Pruefungsboegen1.pdf`) ist per `.gitignore` ausgenommen.
