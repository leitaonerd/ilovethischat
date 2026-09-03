#!/usr/bin/env python3
"""
parse.py — WhatsApp `.txt` archive -> static JSON chunks + index + search index.

Designed for a purely static (GitHub Pages) deployment, so the data is split
into small per-month JSON files and a compact search index, instead of relying
on a server-side SQLite database.

Outputs (under OUT_DIR):
  index.json                 Global metadata (senders, month list, counts, media manifest)
  data/YYYY-MM.json          One message list per month
  search/index.json          Search index manifest (term -> month -> doc/postings)
  search/YYYY-MM.json        Per-month inverted index for search + hit highlighting
"""

from __future__ import annotations

import argparse
import json
import os
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# One or more timestamp shapes appear across WhatsApp exports. We normalise to
# ISO-8601. The regex below is anchored (lookahead) so multi-line messages are
# NOT split wrongly — a new entry only starts at a recognised timestamp.
TIMESTAMP_RE = re.compile(
    r"^(?P<date>\d{1,2}/\d{1,2}/\d{4})[,,\s/]+\s*(?P<time>\d{1,2}:\d{2})\s*-\s*(?P<rest>.*)$"
)

# A message body that is *only* a media marker: `filename (arquivo anexado)`,
# or the English/other-locale equivalents "(file attached)" / "<Media omitted>".
MEDIA_MARKER_RE = re.compile(
    r"^\s*\u200e?\s*(?P<file>.+?)\s*\((file attached|arquivo anexado|attaché)\)\s*$",
    re.I,
)

# System / non-conversational lines (encryption banner, group events, etc.).
SYSTEM_RE = re.compile(
    r"(mensagens e chamadas s[ãa]o protegidas com criptografia de ponta a ponta"
    r"|end-to-end encrypted|messages and calls are secured with end-to-end encryption"
    r"|criou o grupo|adicionou|saiu|removeu|mudou o assunto|mudou o nome"
    r"|changed the subject|added|removed|left|created the group)",
    re.I,
)

AUDIO_EXTS = {".opus", ".mp3", ".m4a", ".aac", ".ogg", ".wav"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".3gp", ".webm"}
STICKER_EXTS = {".webp"}  # STK-*.webp files are stickers (still images)
DOC_EXTS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".vcf", ".zip"}
# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def normalize_text(text: str) -> str:
    """Lowercase + decompose accents, used for the search index tokens."""
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return text.lower()


def tokenize(text: str) -> list[str]:
    """Very small tokeniser. Keeps unicode letters/digits, drops emoji/punct."""
    return re.findall(r"[\w\u00c0-\u024f']+", normalize_text(text))


def classify_media(filename: str) -> str | None:
    """Return a media type for a filename, or None if it is not media."""
    base, ext = os.path.splitext(filename.lower())
    ext = "." + ext.lstrip(".")
    if ext in STICKER_EXTS and ("stk-" in base or "/stk-" in base):
        return "sticker"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in DOC_EXTS:
        return "document"
    return None


def parse_timestamp(date_str: str, time_str: str) -> datetime | None:
    """Parse DD/MM/YYYY + HH:MM into a datetime, return None on failure."""
    try:
        return datetime.strptime(
            f"{date_str.strip()} {time_str.strip()}", "%d/%m/%Y %H:%M"
        )
    except ValueError:
        return None

# ---------------------------------------------------------------------------
# Core parser
# ---------------------------------------------------------------------------


class ChatMessage:
    __slots__ = ("ts", "iso", "sender", "body", "kind", "filename", "media_type")

    def __init__(self, ts, iso, sender, body, kind, filename=None, media_type=None):
        self.ts = ts                # ISO-8601 string
        self.iso = iso              # same, kept for clarity
        self.sender = sender
        self.body = body
        self.kind = kind            # "text" | "media" | "system"
        self.filename = filename
        self.media_type = media_type

    def to_dict(self) -> dict:
        d = {
            "ts": self.ts,
            "sender": self.sender,
            "kind": self.kind,
            "body": self.body,
        }
        if self.filename:
            d["file"] = self.filename
        if self.media_type:
            d["media"] = self.media_type
        return d


def parse_chat(read_path: str, senders: dict[str, str] | None = None) -> list[ChatMessage]:
    """
    Parse a WhatsApp export file into a chronological list of ChatMessage.

    `senders` maps exact sender names from the file to display labels
    (e.g. {'Rafael': 'Rafael', 'Amor 💖': 'AMOR'}). Names not found are kept as-is.
    """
    senders = senders or {}

    with open(read_path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read().splitlines()

    messages: list[ChatMessage] = []
    cur_sender = None

    for line in raw:
        m = TIMESTAMP_RE.match(line)
        if m:
            # ---- start of a new entry ----
            date_s, time_s, rest = m.group("date"), m.group("time"), m.group("rest")

            # Split the sender out of the rest, if present: "Rafael: body"
            sender = None
            body = rest
            split = re.match(r"^(?P<s>[^:]+):\s*(?P<b>.*)$", rest)
            if split:
                sender = split.group("s").strip()
                body = split.group("b")

            dt = parse_timestamp(date_s, time_s)
            iso = dt.isoformat(timespec="minutes") if dt else None
            if sender:
                cur_sender = sender

            kind, filename, media_type = "text", None, None
            media_m = MEDIA_MARKER_RE.match(body.strip())
            if media_m:
                filename = media_m.group("file").strip()
                media_type = classify_media(filename)
                if media_type:
                    kind = "media"
                    body = ""
            elif sender is None:
                # Lines with no "Sender:" prefix are system messages
                # (encryption banner, group events). Avoids false positives
                # from words like "saiu" inside real messages.
                kind = "system"
                filename = None
                media_type = None
                body = rest

            display_sender = senders.get(cur_sender, cur_sender) if cur_sender else None
            messages.append(
                ChatMessage(iso, iso, display_sender, body, kind, filename, media_type)
            )
        else:
            # ---- continuation line of a multi-line message ----
            if messages:
                prev = messages[-1]
                if prev.kind == "media" and not prev.body:
                    prev.body = line
                else:
                    prev.body = (prev.body + "\n" + line).strip()
            # else: stray leading line with no context -> ignore

    return messages
# ---------------------------------------------------------------------------
# Search index construction
# ---------------------------------------------------------------------------


def build_search_index(messages: list[ChatMessage]) -> dict:
    """
    Build a per-month inverted index for client-side search.

    Structure (per month):
      {
        "docs": [off_t, off_b, len_t, len_b, ...],   # flat alternating arrays
        "terms": {"token": [docid, count, ...], ...}
      }
    """
    term_positions: dict[str, list[tuple[int, int]]] = defaultdict(list)
    docs: list[int] = []  # flat: [tok_start, body_start, tok_len, body_len]

    # docid must equal the message's position within the month's records array,
    # because the frontend resolves search hits via records[docid]. So we use
    # enumerate over ALL messages (skipped ones just have no postings).
    for docid, msg in enumerate(messages):
        if msg.kind not in ("text", "media"):
            continue
        text = msg.body or ""
        toks = tokenize(text)
        if not toks:
            continue
        docs.extend([0, 0, len(toks), len(text)])
        for off, t in enumerate(toks):
            term_positions[t].append((docid, off))

    index_terms: dict[str, list[int]] = {}
    for term, pos in term_positions.items():
        flat: list[int] = []
        for d, off in pos:
            flat.extend([d, off])
        index_terms[term] = flat

    return {"docs": docs, "terms": index_terms}


# ---------------------------------------------------------------------------
# Output writing
# ---------------------------------------------------------------------------


def write_monthly_chunks(messages, out_dir, search_out_dir):
    """Group messages by YYYY-MM, write one JSON file (messages + index) per month."""
    by_month: dict[str, list[ChatMessage]] = defaultdict(list)
    for m in messages:
        month = m.ts[:7] if m.ts else "unknown"
        by_month[month].append(m)

    for month, mlist in sorted(by_month.items()):
        safe = "unknown" if month == "unknown" else month
        records = [m.to_dict() for m in mlist]

        path = os.path.join(out_dir, f"{safe}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(records, fh, ensure_ascii=False, separators=(",", ":"))

        if month != "unknown":
            idx = build_search_index(mlist)
            spath = os.path.join(search_out_dir, f"{safe}.json")
            with open(spath, "w", encoding="utf-8") as fh:
                json.dump(idx, fh, ensure_ascii=False, separators=(",", ":"))

    return sorted(by_month.keys())


def build_index_manifest(messages, months, media_manifest=None) -> dict:
    counts = Counter()
    kind_counts = Counter()
    for m in messages:
        counts[m.sender or "?"] += 1
        kind_counts[m.kind] += 1

    sender_list = sorted(set(s for s in counts if s and s != "?"))
    return {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "total_messages": len(messages),
        "by_kind": dict(kind_counts),
        "senders": sender_list,
        "by_sender": dict(counts),
        "months": months,
        "media_manifest": media_manifest or {},
    }
# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Parse WhatsApp export into static JSON.")
    parser.add_argument("input", help="Path to the WhatsApp .txt export")
    parser.add_argument("--out", default="site/data", help="Output dir for month chunks")
    parser.add_argument("--search-out", default="site/search",
                        help="Output dir for search index")
    parser.add_argument("--manifest", default=None,
                        help="Path to media manifest JSON (optional)")
    parser.add_argument("--manifest-out", default="site/data/index.json",
                        help="Global manifest output")
    parser.add_argument("--senders", default=None,
                        help='JSON map of file names -> display labels')
    args = parser.parse_args()

    in_path = args.input
    if not os.path.exists(in_path):
        print(f"[parse] ERROR: input not found: {in_path}")
        raise SystemExit(1)

    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.search_out, exist_ok=True)

    senders = None
    if args.senders:
        try:
            senders = json.loads(args.senders)
        except json.JSONDecodeError as e:
            print(f"[parse] WARNING: could not parse --senders ({e}); using raw names")

    print(f"[parse] reading: {in_path}")
    messages = parse_chat(in_path, senders)
    print(f"[parse] parsed {len(messages)} messages")

    months = write_monthly_chunks(messages, args.out, args.search_out)
    print(f"[parse] wrote {len(months)} month chunks: {months[:8]} ...")

    media_manifest = None
    if args.manifest and os.path.exists(args.manifest):
        with open(args.manifest, "r", encoding="utf-8") as fh:
            media_manifest = json.load(fh)

    manifest = build_index_manifest(messages, months, media_manifest)
    os.makedirs(os.path.dirname(args.manifest_out), exist_ok=True)
    with open(args.manifest_out, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print(f"[parse] wrote manifest: {args.manifest_out}")
    print(f"[parse] total: {manifest['total_messages']}, "
          f"by sender: {manifest['by_sender']}")


if __name__ == "__main__":
    main()