#!/usr/bin/env python3
"""Merge base questions (sks_questions.json) with the enrichment files
(enrich/output/bogen_NN.json) into the app data file app/data.js + app/data.json.

Run after the enrichment subagents have produced enrich/output/*.json.
"""
import glob
import json
import os
import sys

BASE = "sks_questions.json"
OUT_DIR = "docs"
REQUIRED = ["kurzantwort", "erklaerung", "kernpunkte", "wichtigkeit"]


def main():
    base = json.load(open(BASE))
    enrich = {}
    files = sorted(glob.glob("enrich/output/bogen_*.json"))
    for fp in files:
        try:
            arr = json.load(open(fp))
        except Exception as e:
            print(f"FEHLER beim Lesen {fp}: {e}")
            continue
        for e in arr:
            enrich[e["id"]] = e

    merged = []
    problems = []
    for q in base:
        e = enrich.get(q["id"])
        item = dict(q)
        if not e:
            problems.append(f"{q['id']}: kein Enrichment")
            e = {}
        for f in REQUIRED:
            if f not in e or e[f] in (None, "", []):
                if not (f == "wichtigkeit" and e.get(f) == 0):
                    problems.append(f"{q['id']}: Feld '{f}' fehlt/leer")
        item["kurzantwort"] = e.get("kurzantwort", "")
        item["erklaerung"] = e.get("erklaerung", "")
        item["kernpunkte"] = e.get("kernpunkte", [])
        item["wichtigkeit"] = e.get("wichtigkeit", 2)
        merged.append(item)

    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(merged, open(f"{OUT_DIR}/data.json", "w"), ensure_ascii=False, indent=2)
    with open(f"{OUT_DIR}/data.js", "w") as f:
        f.write("window.SKS_DATA = ")
        json.dump(merged, f, ensure_ascii=False)
        f.write(";\n")

    enriched = sum(1 for m in merged if m["kurzantwort"])
    print(f"Fragen gesamt: {len(merged)} | mit Enrichment: {enriched} | Enrich-Dateien: {len(files)}")
    print(f"Probleme: {len(problems)}")
    for p in problems[:40]:
        print("  -", p)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
