# Enrichment-Spec für SKS-Fragen

Ziel: Für jede SKS-Prüfungsfrage Zusatzinhalte erzeugen, die a) schnelles Lernen,
b) Verständnis und c) eine **offline** Antwort-Prüfung über Kernpunkte ermöglichen.

## Eingabe
Eine Datei `input/bogen_NN.json` mit 30 Objekten: `{id, frage, musterantwort}`.

## Ausgabe
Eine Datei `output/bogen_NN.json`: ein JSON-Array mit **genau denselben 30 ids**,
jedes Objekt mit diesen Feldern:

```json
{
  "id": "1-1",
  "kurzantwort": "Sehr knappe Kernaussage zum Auswendiglernen. Max ~140 Zeichen. Stichpunktartig erlaubt.",
  "erklaerung": "2-4 Sätze, einfach und verständlich: WARUM ist das so / Kontext / ggf. Eselsbrücke. Keine Wiederholung der Frage.",
  "kernpunkte": [
    { "punkt": "World Geodetic System 1984", "synonyme": ["WGS 84", "WGS84", "weltweites Bezugssystem", "Referenzellipsoid"] },
    { "punkt": "optimale Anpassung an die Erdform / Grundlage für GPS", "synonyme": ["GPS", "Erdkörper", "weltweit gültig", "Geoid"] }
  ],
  "wichtigkeit": 3
}
```

## Regeln
- **kurzantwort**: das Minimum, das man wissen muss. Kurz! Wenn die Musterantwort mehrere
  Aufzählungspunkte hat, nenne die 2-4 wichtigsten knapp.
- **erklaerung**: hilft beim Verstehen, nicht nur Auswendiglernen. Locker, klar, deutsch.
- **kernpunkte**: 1-4 Punkte, die für die volle Punktzahl genannt sein müssen.
  - `punkt` = der inhaltliche Kernbegriff/-gedanke (kurz).
  - `synonyme` = 3-8 Begriffe/Formulierungen, die als "richtig erkannt" gelten sollen
    (inkl. Abkürzungen, alternative Schreibweisen, umgangssprachliche Varianten, einzelne
    Schlüsselwörter). Wichtig für die automatische Erkennung getippter Antworten.
  - Wähle Synonyme so, dass eine sinngemäß richtige Tippantwort mindestens eines pro Punkt trifft.
- **wichtigkeit**: 1-3 (3 = sehr wichtig/prüfungsrelevant/häufig, 2 = normal, 1 = Randwissen).
- Inhaltlich an der Musterantwort orientieren, nichts erfinden. Fachlich korrekt (SKS/Seeschifffahrt).
- Ausgabe = **nur valides JSON** (UTF-8), keine Kommentare, keine ``` ```-Fences in der Datei.
