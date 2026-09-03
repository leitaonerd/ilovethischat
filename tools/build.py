#!/usr/bin/env python3
"""
build.py — Orchestrates the full static site build.

Reads tools/config.json, then:
  1. Parses the WhatsApp export (parse.py) into monthly JSON + search index.
  2. Processes media (media.py): copy assets, transcode .opus -> .m4a.
  3. Emits a media manifest used by the frontend.
Imported/run as a module so no fragile shell quoting of spaces/emoji is needed.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import parse as parse_mod
import media as media_mod


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main() -> None:
    cfg_path = os.path.join(HERE, "config.json")
    cfg = load_config(cfg_path)

    input_txt = os.path.join(os.path.dirname(HERE), cfg["input_txt"])
    media_in = os.path.join(os.path.dirname(HERE), cfg["media_dir"])
    site_dir = os.path.join(os.path.dirname(HERE), cfg["site_dir"])

    os.makedirs(site_dir, exist_ok=True)

    # ---- media processing first (produces the manifest) ----
    out_media = os.path.join(site_dir, "media")
    os.makedirs(out_media, exist_ok=True)
    media_manifest = media_mod.process_media(
        media_in,
        out_media,
        transcode_opus=cfg.get("transcode_opus", True),
        ffmpeg=cfg.get("ffmpeg", "ffmpeg"),
    )

    manifest_path = os.path.join(site_dir, "data", "media_manifest.json")
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(media_manifest, fh, ensure_ascii=False, indent=2)
    print(f"[build] wrote media manifest: {manifest_path}")

    # ---- parse the chat ----
    sys.argv = [
        "parse.py",
        input_txt,
        "--out", os.path.join(site_dir, "data"),
        "--search-out", os.path.join(site_dir, "search"),
        "--manifest", manifest_path,
        "--manifest-out", os.path.join(site_dir, "data", "index.json"),
        "--senders", json.dumps(cfg.get("senders", {}), ensure_ascii=False),
    ]
    parse_mod.main()

    print("[build] done.")


if __name__ == "__main__":
    main()