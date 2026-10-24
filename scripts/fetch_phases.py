#!/usr/bin/env python3
"""Build data/phases/<FORMULA>.json — the phase viewer's offline COD cache.

The Crystallography Open Database sends no Access-Control-Allow-Origin header
(checked 2026-10-24 on both /cod/result and /cod/<id>.cif), so a page served
from github.io cannot call it directly. Everything the viewer needs is fetched
here and committed, which also means the page keeps working when COD is down —
it was returning truncated responses as recently as 2026-10-23.

COD matches `formula` against its own normalised string: elements in
alphabetical order, a count of 1 written as nothing. VO2 is 'O2 V'. Any other
spelling silently returns zero rows, so the normalisation is tested below.

Usage:  python3 scripts/fetch_phases.py VO2 TiO2 NbSe2
        python3 scripts/fetch_phases.py --refresh        # rebuild what exists
"""
import json, re, sys, time, urllib.parse, urllib.request, pathlib, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "data/phases"
BASE = "https://www.crystallography.net/cod"
UA = {"User-Agent": "uk-card-site phase viewer (research use; aowlr8945@gmail.com)"}
MAX_ENTRIES = 40          # one JSON file stays well under 200 kB


def parse_formula(text):
    """'VO2' / 'V O2' / 'La0.7Sr0.3MnO3' -> [(element, count), ...]"""
    out = []
    for el, num in re.findall(r"([A-Z][a-z]?)\s*([0-9]*\.?[0-9]*)", text):
        if el:
            out.append((el, float(num) if num else 1.0))
    return out


def cod_formula(text):
    """The string COD stores: alphabetical, count dropped when it is 1."""
    parts = parse_formula(text)
    if not parts:
        return ""
    bits = []
    for el, n in sorted(parts):
        bits.append(el if abs(n - 1) < 1e-9 else f"{el}{n:g}")
    return " ".join(bits)


def get(url, timeout=60, tries=3):
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as exc:          # COD truncates responses under load
            last = exc
            time.sleep(2 * (k + 1))
    raise RuntimeError(f"{url}: {last}")


def search(formula):
    q = urllib.parse.urlencode({"format": "json", "formula": cod_formula(formula)})
    rows = json.loads(get(f"{BASE}/result?{q}") or b"[]")
    return rows


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build(formula):
    rows = search(formula)
    if not rows:
        print(f"  {formula}: COD returned no rows for '{cod_formula(formula)}'")
        return None
    rows.sort(key=lambda r: (num(r.get("sgNumber")) or 999, str(r.get("file"))))
    entries = []
    for r in rows[:MAX_ENTRIES]:
        cid = str(r.get("file"))
        try:
            cif = get(f"{BASE}/{cid}.cif").decode("utf-8", "replace")
        except RuntimeError as exc:
            print(f"    {cid}: CIF not fetched ({exc}); entry skipped")
            continue
        entries.append({
            "cod_id": cid,
            "formula": (r.get("formula") or "").strip(" -"),
            "spacegroup": r.get("sg"),
            "sg_number": num(r.get("sgNumber")),
            "a": num(r.get("a")), "b": num(r.get("b")), "c": num(r.get("c")),
            "alpha": num(r.get("alpha")) or 90.0,
            "beta": num(r.get("beta")) or 90.0,
            "gamma": num(r.get("gamma")) or 90.0,
            "volume": num(r.get("vol")),
            # Temperature is the reason two records of one phase differ; a VO2
            # cell measured at 373 K is the rutile phase, at 298 K it is not.
            "temperature": num(r.get("celltemp")) or num(r.get("diffrtemp")),
            "title": (r.get("title") or "").strip(),
            "authors": (r.get("authors") or "").strip(),
            "journal": (r.get("journal") or "").strip(),
            "year": num(r.get("year")),
            "doi": (r.get("doi") or "").strip(),
            "mineral": (r.get("mineral") or "").strip(),
            "chemname": (r.get("chemname") or "").strip(),
            "url": f"{BASE}/{cid}.html",
            "cif": cif,
        })
        print(f"    {cid}  {r.get('sg')}  {r.get('a')} {r.get('b')} {r.get('c')}")
    return {
        "formula": formula,
        "cod_query": cod_formula(formula),
        "fetched": datetime.date.today().isoformat(),
        "source": "Crystallography Open Database (public domain data)",
        "entries": entries,
    }


def main(argv):
    OUTDIR.mkdir(parents=True, exist_ok=True)
    if "--refresh" in argv:
        names = [p.stem for p in sorted(OUTDIR.glob("*.json"))]
    else:
        names = [a for a in argv if not a.startswith("-")]
    if not names:
        print(__doc__)
        return 1
    index = []
    for name in names:
        print(f"  {name}  ->  COD formula '{cod_formula(name)}'")
        data = build(name)
        if not data:
            continue
        path = OUTDIR / f"{name}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"    wrote {path.relative_to(ROOT)}  ({path.stat().st_size // 1024} kB, {len(data['entries'])} records)")
    for p in sorted(OUTDIR.glob("*.json")):
        if p.name == "index.json":
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        index.append({"formula": d["formula"], "records": len(d["entries"]), "fetched": d["fetched"]})
    (OUTDIR / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


# The normalisation is the one thing that fails silently, so it is checked on
# every run rather than left to a separate test.
assert cod_formula("VO2") == "O2 V", cod_formula("VO2")
assert cod_formula("NbSe2") == "Nb Se2", cod_formula("NbSe2")
assert cod_formula("SrRuO3") == "O3 Ru Sr", cod_formula("SrRuO3")

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
