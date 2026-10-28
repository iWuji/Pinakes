#!/usr/bin/env python3
"""Match arXiv lookup results to notes and (optionally) backfill the arxiv field."""
import difflib, json, re, sys
from pathlib import Path
import yaml

APPLY = "--apply" in sys.argv
THRESHOLD = 0.90

lookup = json.load(open("/tmp/arxiv_lookup.json"))


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()


def core(title: str) -> str:
    return re.sub(r"^[A-Z][A-Za-z0-9\-]*:\s*", "", title)


rows, unmatched, ambiguous = [], [], []
for path, info in lookup.items():
    cands = info["cands"]
    if not cands:
        unmatched.append((path, info["title"], "no candidate"))
        continue
    scored = sorted(
        ((difflib.SequenceMatcher(None, norm(core(info["title"])), norm(c[1])).ratio(), c) for c in cands),
        reverse=True,
    )
    best_score, best = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0
    if best_score < THRESHOLD:
        unmatched.append((path, info["title"], f"best={best_score:.3f} {best[1][:60]}"))
        continue
    if second > THRESHOLD and second > best_score - 0.02:
        ambiguous.append((path, info["title"], best, scored[1][1], best_score))
        continue
    rows.append((path, info["title"], best[0], best[1], best_score))

print(f"matched {len(rows)} / unmatched {len(unmatched)} / ambiguous {len(ambiguous)}")
for r in unmatched:
    print("  MISS", r[0].split("/")[-1][:60], "|", r[2])
for r in ambiguous:
    print("  AMBIG", r[1][:60], "|", r[2][0], "vs", r[3][0])

if not APPLY:
    print("\nDry-run. Matched preview:")
    for path, title, aid, atitle, score in rows[:15]:
        print(f"  {score:.2f} {aid:<14} {atitle[:60]}")
    sys.exit(0)

changed = 0
for path, title, aid, atitle, score in rows:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    m = re.match(r"^(---\s*\n)(.*?\n)(---\s*\n)", text, re.DOTALL)
    if not m:
        print("SKIP no frontmatter", path)
        continue
    fm = m.group(2)
    if re.search(r"^arxiv:", fm, re.M):
        continue
    line = f'arxiv: "{re.sub(r"v[0-9]+$", "", aid)}"\n'
    m_venue = re.search(r"^venue:", fm, re.M)
    if m_venue:
        fm_new = fm[: m_venue.start()] + line + fm[m_venue.start():]
    else:
        fm_new = fm.rstrip("\n") + "\n" + line
    new_text = m.group(1) + fm_new + m.group(3) + text[m.end():]
    parsed = yaml.safe_load(re.match(r"^---\s*\n(.*?)\n---", new_text, re.DOTALL).group(1))
    assert parsed.get("arxiv") == re.sub(r"v[0-9]+$", "", aid), path
    p.write_text(new_text, encoding="utf-8")
    changed += 1

print(f"wrote arxiv into {changed} notes")
