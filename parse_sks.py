#!/usr/bin/env python3
"""Parse SKS-Pruefungsboegen1.pdf into structured JSON.

Each Pruefungsbogen has a question section followed by an "Auswertung"
section that contains: Nr / Kategorie / (truncated) question / "/ <pts>" / answer.
We take answers (+points+category) from the Auswertung and the full question
text from the question section.
"""
import json
import re
import sys

import fitz

PDF = "SKS-Pruefungsboegen1.pdf"


def load_pages():
    doc = fitz.open(PDF)
    return [p.get_text() for p in doc]


def classify_pages(pages):
    """Group page texts by bogen number, split into question vs auswertung text."""
    bogen = {}  # num -> {"q": [lines], "a": [lines]}
    cur = None
    mode = None
    for txt in pages:
        m_aus = re.search(r"Auswertung:\s*Pr\u00fcfungsbogen\s+(\d+)\s+von", txt)
        m_q = re.search(r"Pr\u00fcfungsbogen\s+(\d+)\s+von", txt)
        if m_aus:
            # first page of an evaluation section
            cur = int(m_aus.group(1))
            mode = "a"
        elif m_q:
            n = int(m_q.group(1))
            if cur is None or n != cur:
                # a new bogen's question section begins
                cur = n
                mode = "q"
            # else: same bogen number -> continuation page, keep current mode
        if cur is None:
            continue
        bogen.setdefault(cur, {"q": [], "a": []})
        bogen[cur][mode].append(txt)
    return bogen


def parse_questions(qtext):
    """Return dict {num: full_question_text} for one bogen."""
    # join all question pages, drop page headers
    lines = []
    for page in qtext:
        for ln in page.splitlines():
            s = ln.strip()
            if not s:
                continue
            if s.startswith("Seite "):
                continue
            if s.startswith("Pr\u00fcfungsbogen "):
                continue
            if s.startswith("Sportk\u00fcstenschifferschein"):
                continue
            if s.startswith("Die Pr\u00fcfungszeit"):
                continue
            lines.append(s)
    questions = {}
    expected = 1
    cur_num = None
    buf = []
    for s in lines:
        m = re.match(r"^(\d+)\.\s*(.*)$", s)
        if m and int(m.group(1)) == expected:
            # boundary: new question
            if cur_num is not None:
                questions[cur_num] = " ".join(buf).strip()
            cur_num = expected
            buf = [m.group(2)] if m.group(2) else []
            expected += 1
        else:
            if cur_num is not None:
                buf.append(s)
    if cur_num is not None:
        questions[cur_num] = " ".join(buf).strip()
    return questions


def parse_auswertung(atext):
    """Return list of dicts {num, kategorie, q_trunc, points, answer}."""
    lines = []
    for page in atext:
        for ln in page.splitlines():
            s = ln.strip()
            if not s:
                continue
            if s.startswith("Seite "):
                continue
            if re.match(r"^Auswertung:", s):
                continue
            if re.match(r"^Pr\u00fcfungsbogen ", s):
                continue
            if s.startswith("Sportk\u00fcstenschifferschein"):
                continue
            if s in ("Nr.", "Kategorie", "Frage", "Antwort", "Punkte"):
                continue
            lines.append(s)

    def is_footer(s):
        return (
            s == "ID"
            or s.startswith("Erreichte Punkte")
            or s.startswith("Bestanden")
            or s.startswith("____")
            or s == "SKS-Fragen"
        )

    def is_item_start(k):
        return (
            re.match(r"^\d+$", lines[k])
            and k + 1 < n
            and not re.match(r"^[/\d]", lines[k + 1])
            and not is_footer(lines[k + 1])
        )

    items = []
    i = 0
    n = len(lines)
    while i < n:
        if is_item_start(i):
            num = int(lines[i])
            kat = lines[i + 1]
            j = i + 2
            # gather the whole block until next item start or footer
            block = []
            while j < n and not is_footer(lines[j]) and not is_item_start(j):
                block.append(lines[j])
                j += 1
            # split block into question (trunc) / points / answer
            points = 2
            pts_idx = next(
                (k for k, b in enumerate(block) if re.match(r"^/\s*\d+$", b)), None
            )
            if pts_idx is not None:
                q_parts = block[:pts_idx]
                points = int(re.match(r"^/\s*(\d+)$", block[pts_idx]).group(1))
                ans = block[pts_idx + 1:]
            else:
                # no points marker (rare): question is the line ending with "..."
                dot_idx = next(
                    (k for k, b in enumerate(block) if b.endswith("...")), 0
                )
                q_parts = block[: dot_idx + 1]
                ans = block[dot_idx + 1:]
            items.append({
                "num": num,
                "kategorie": kat,
                "q_trunc": " ".join(q_parts).strip(),
                "points": points,
                "answer": " ".join(ans).strip(),
            })
            i = j
        else:
            i += 1
    return items


def main():
    pages = load_pages()
    bogen = classify_pages(pages)
    result = []
    problems = []
    for num in sorted(bogen):
        qs = parse_questions(bogen[num]["q"])
        aus = parse_auswertung(bogen[num]["a"])
        if len(aus) != 30:
            problems.append(f"Bogen {num}: {len(aus)} Auswertungs-Eintr\u00e4ge (erwartet 30)")
        if len(qs) != 30:
            problems.append(f"Bogen {num}: {len(qs)} Fragen geparst (erwartet 30)")
        for a in aus:
            full_q = qs.get(a["num"], "")
            # sanity: truncated question prefix should match full question
            trunc = a["q_trunc"].rstrip(".").rstrip()
            trunc_core = trunc[:-3] if trunc.endswith("...") else trunc
            ok = bool(full_q) and (trunc_core[:15] in full_q or full_q[:15] in trunc_core)
            if not ok:
                problems.append(
                    f"Bogen {num} Frage {a['num']}: Q-Match unsicher "
                    f"(trunc='{a['q_trunc'][:25]}' full='{full_q[:25]}')"
                )
            result.append({
                "bogen": num,
                "num": a["num"],
                "id": f"{num}-{a['num']}",
                "kategorie": a["kategorie"],
                "frage": full_q or a["q_trunc"],
                "frage_vollstaendig": bool(full_q),
                "antwort": a["answer"],
                "punkte": a["points"],
            })
    with open("sks_questions.json", "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    # also emit a JS file the offline app can load via <script src>
    with open("sks_data.js", "w") as f:
        f.write("window.SKS_DATA = ")
        json.dump(result, f, ensure_ascii=False)
        f.write(";\n")
    print(f"Boegen: {len(bogen)}  Fragen gesamt: {len(result)}")
    print(f"Probleme: {len(problems)}")
    for p in problems[:40]:
        print("  -", p)


if __name__ == "__main__":
    main()
