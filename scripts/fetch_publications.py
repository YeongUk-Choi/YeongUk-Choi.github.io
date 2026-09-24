#!/usr/bin/env python3
"""Refresh data/publications.js from a verified DOI list.

Source of truth: the DOI list below (verified by hand against Google Scholar / OpenAlex on 2026-09-22).
Bibliographic fields come from Crossref; missing abstracts are filled from OpenAlex.
Manual fields (image, imageCaption, imageCredit, featured, abstract for closed-access papers) in the
existing data/publications.js are preserved by DOI — edit them by hand, then rerun this script.

Usage:  python3 scripts/fetch_publications.py            # refresh
        python3 scripts/fetch_publications.py --add DOI  # add a new paper, then refresh
Google Scholar has no public API and blocks automated access; it is used only as the profile link."""
import json, re, sys, html, urllib.request, urllib.parse, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data/publications.js"
MAILTO = "aowlr8945@gmail.com"
DOIS = [
    "10.1021/acssensors.6c01299", "10.1007/s40042-026-01632-6", "10.1002/pssr.70202",
    "10.1016/j.mtphys.2026.102024", "10.1002/aenm.202500856", "10.1021/acsaem.5c00786",
    "10.1007/s40042-025-01330-9", "10.1016/j.ceramint.2024.07.399", "10.1016/j.cap.2024.06.012",
    "10.3390/s24061927", "10.3390/cryst13121613",
]
SUBS = [("VO 2", "VO₂"), ("VO2", "VO₂"), ("2H-NbSe2", "2H-NbSe₂"), ("NbSe2", "NbSe₂"), ("SrRuO3", "SrRuO₃"), ("CoFe2O4", "CoFe₂O₄"), ("LaNiO3", "LaNiO₃"),
        ("Pb(Zr,Ti)O3", "Pb(Zr,Ti)O₃"), ("MAPbBr3-xClx", "MAPbBr₃₋ₓClₓ")]
MANUAL = ("image", "imageCaption", "imageCredit", "featured", "note")

def get(url, accept="application/json"):
    req = urllib.request.Request(url, headers={"User-Agent": f"uk-card-site (mailto:{MAILTO})", "Accept": accept})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)

SUBDIG = str.maketrans("0123456789+-x", "₀₁₂₃₄₅₆₇₈₉₊₋ₓ")
def strip(s):
    s = html.unescape(s or "").replace("\xa0", " ")
    s = re.sub(r"\s*<sub>\s*([0-9+\-x]+)\s*</sub>", lambda m: m.group(1).translate(SUBDIG), s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\$\$?\\Delta_\{?(\d)\}?\s*\\sim\s*([\d.]+)\$\$?", lambda m: "Δ" + m.group(1).translate(SUBDIG) + " ≈ " + m.group(2), s)  # $$\Delta_{1} \sim 1.68$$
    s = re.sub(r"\$\$?([^$]{1,40})\$\$?", r"\1", s)                                    # any other inline TeX: drop the dollars
    s = s.replace("&nbsp;", " ").replace("$$", "")
    s = re.sub(r"\s+", " ", s).strip()
    return re.sub(r"^Abstract\s*", "", s)

def inv(ii):
    if not ii: return ""
    pos = {p: w for w, ps in ii.items() for p in ps}
    return " ".join(pos[i] for i in sorted(pos))

def existing():
    if not OUT.exists(): return {}
    m = re.search(r"window\.SITE\.publications = (\[.*?\]);", OUT.read_text(), re.S)
    return {p["doi"]: p for p in json.loads(m.group(1))} if m else {}

def fetch(doi):
    c = get(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}")["message"]
    title = strip(c["title"][0])
    for a, b in SUBS: title = title.replace(a, b)
    rec = {
        "year": c["issued"]["date-parts"][0][0], "title": title,
        "authors": ", ".join(f"{a.get('given','')} {a.get('family','')}".strip() for a in c.get("author", [])),
        "journal": (c.get("container-title") or [""])[0], "volume": c.get("volume", ""), "issue": c.get("issue", ""),
        "page": c.get("page", "") or c.get("article-number", ""), "doi": doi, "abstract": strip(c.get("abstract", "")),
        "license": (c.get("license") or [{}])[0].get("URL", ""),
    }
    if not rec["abstract"]:
        try: rec["abstract"] = strip(inv(get(f"https://api.openalex.org/works/https://doi.org/{doi}?mailto={MAILTO}").get("abstract_inverted_index")))
        except Exception: pass
    for a, b in SUBS: rec["abstract"] = rec["abstract"].replace(a, b)
    return rec

def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--add": DOIS.append(sys.argv[2])
    old = existing(); pubs = []
    for doi in DOIS:
        try: rec = fetch(doi)
        except Exception as e: print("skip", doi, e); rec = old.get(doi)
        if not rec: continue
        prev = old.get(doi, {})
        for k in MANUAL: rec[k] = prev.get(k, False if k == "featured" else "")
        if not rec["abstract"] and prev.get("abstract"): rec["abstract"] = strip(prev["abstract"])   # hand-entered abstract survives
        pubs.append(rec); print(rec["year"], doi, "abs" if rec["abstract"] else "no-abs", "img" if rec["image"] else "")
    pubs.sort(key=lambda p: -p["year"])
    meta = {"source": "scholar", "updated": datetime.date.today().isoformat(), "count": len(pubs), "scholarUser": "GAX2tHgAAAAJ"}
    OUT.write_text(
        "// 논문 목록 — 검증된 DOI 목록(scripts/fetch_publications.py) 기준. 서지는 Crossref, 빈 초록은 OpenAlex로 보강.\n"
        "// 손으로 고치는 칸: image(assets/img/pubs/…), imageCaption, imageCredit(라이선스·출처), featured(상단 고정), abstract(닫힌 논문).\n"
        "// 이 칸들은 스크립트를 다시 돌려도 DOI 기준으로 보존됩니다. Google Scholar는 프로필 링크로만 씁니다.\n"
        "window.SITE = window.SITE || {};\n"
        f"window.SITE.publicationsMeta = {json.dumps(meta, ensure_ascii=False)};\n"
        f"window.SITE.publications = {json.dumps(pubs, ensure_ascii=False, indent=2)};\n")
    print("wrote", OUT, len(pubs))

if __name__ == "__main__": main()
