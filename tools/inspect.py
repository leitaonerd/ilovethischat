#!/usr/bin/env python3
"""Inspect the generated static data for correctness."""
import glob
import json
import os

SITE = os.path.join(os.path.dirname(__file__), "..", "site")

idx = json.load(open(os.path.join(SITE, "data", "index.json"), encoding="utf-8"))
print("TOTAL", idx["total_messages"])
print("by_kind", idx["by_kind"])
print("by_sender", idx["by_sender"])
print("months", idx["months"])

manifest = idx["media_manifest"]
print("media manifest entries:", len(manifest))

# --- inspect first month ---
m = json.load(open(os.path.join(SITE, "data", "2026-03.json"), encoding="utf-8"))
print("\n== 2026-03 messages:", len(m))
for msg in m[:5]:
    print(msg)

# find system messages
sys_msgs = [x for x in m if x["kind"] == "system"]
print("\nsystem messages in 2026-03:", len(sys_msgs))
for s in sys_msgs[:3]:
    print("SYS:", s["body"][:90])

# find a media message with a caption on next line (media + body)
media_msgs = [x for x in m if x["kind"] == "media"]
print("\nmedia messages in 2026-03:", len(media_msgs))
with_cap = [x for x in media_msgs if x.get("body")]
print("media with caption:", len(with_cap))
for mm in media_msgs[:5]:
    print("MED:", mm)

# --- coverage: do all referenced media files resolve in the manifest? ---
missing = set()
total_refs = 0
for f in glob.glob(os.path.join(SITE, "data", "2026-*.json")):
    for rec in json.load(open(f, encoding="utf-8")):
        if rec["kind"] == "media":
            total_refs += 1
            if rec.get("file") not in manifest:
                missing.add(rec["file"])
print("\nmedia refs total:", total_refs, "missing from manifest:", len(missing))

# --- search index alignment: docid in index terms must equal position in data ---
print("\n== search index alignment check ==")
import unicodedata
def norm(s):
    s = unicodedata.normalize("NFD", s)
    return "".join(ch for ch in s if not unicodedata.combining(ch)).lower()
bad = 0
checked = 0
for f in glob.glob(os.path.join(SITE, "search", "2026-*.json")):
    month = os.path.basename(f).replace(".json", "")
    idx = json.load(open(f, encoding="utf-8"))
    records = json.load(open(os.path.join(SITE, "data", month + ".json"), encoding="utf-8"))
    # pick up to 3 terms with postings
    for term, flat in list(idx["terms"].items())[:3]:
        for k in range(0, min(len(flat), 40), 2):
            docid = flat[k]
            text = (records[docid].get("body") or "").lower()
            if term not in norm(text):
                bad += 1
            checked += 1
print("checked postings:", checked, "misaligned:", bad, "OK" if bad == 0 else "ERROR")

# --- sender counts sanity ---
from collections import Counter
c = Counter()
for f in glob.glob(os.path.join(SITE, "data", "2026-*.json")):
    for rec in json.load(open(f, encoding="utf-8")):
        c[rec["sender"]] += 1
print("sender counts across all data:", dict(c))