#!/usr/bin/env python3
"""
media.py — Process WhatsApp media into the static site.

Responsibilities:
  * Copy images, videos, stickers, docs and already-compatible audio into
    site/media/.
  * Transcode `.opus` voice notes to `.m4a` (AAC) so Safari/iOS can play them,
    using `ffmpeg` if available.
  * Build a manifest mapping the original filename (as it appears in the chat)
    to the served asset URL and media type.

The manifest shape:
  {
    "<original filename>": {
      "type": "image|video|audio|sticker|document",
      "src": "media/<filename>",          # served path
      "transcoded": false|true
    },
    ...
  }
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

from parse import classify_media  # reuse the classifier

AUDIO_NEEDS_TRANSCODE = {".opus", ".ogg", ".weba"}


def _ffmpeg_available(ffmpeg: str) -> bool:
    try:
        subprocess.run([ffmpeg, "-version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def _transcode(src: str, dst: str, ffmpeg: str) -> bool:
    """Transcode to m4a (aac). Returns True on success."""
    args = [
        ffmpeg, "-y", "-i", src,
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        dst,
    ]
    res = subprocess.run(args, capture_output=True)
    return res.returncode == 0 and os.path.exists(dst)


def process_media(media_in: str, out_dir: str,
                  transcode_opus: bool = True, ffmpeg: str = "ffmpeg") -> dict:
    """
    Copy/collate media files referenced by the chat into `out_dir`.
    Returns the media manifest dict keyed by original filename.
    """
    manifest: dict = {}
    os.makedirs(out_dir, exist_ok=True)

    has_ffmpeg = _ffmpeg_available(ffmpeg) if transcode_opus else False
    if transcode_opus and not has_ffmpeg:
        print("[media] WARNING: ffmpeg not found; .opus files will be referenced "
              "but may not play on iOS. Install ffmpeg and re-run to transcode.")

    if not os.path.isdir(media_in):
        print(f"[media] WARNING: media dir not found: {media_in}")
        return manifest

    for name in sorted(os.listdir(media_in)):
        src = os.path.join(media_in, name)
        if not os.path.isfile(src):
            continue

        mtype = classify_media(name)
        if not mtype:
            continue

        _, ext = os.path.splitext(name)
        ext = ext.lower()

        # --- audio that needs transcode ---
        if mtype == "audio" and ext in AUDIO_NEEDS_TRANSCODE and has_ffmpeg:
            base = os.path.splitext(name)[0]
            dst_name = base + ".m4a"
            dst = os.path.join(out_dir, dst_name)
            if not os.path.exists(dst):
                ok = _transcode(src, dst, ffmpeg)
                if not ok:
                    print(f"[media] transcode FAILED: {name}")
                    continue
            manifest[name] = {
                "type": "audio",
                "src": "media/" + dst_name,
                "transcoded": True,
            }
            continue

        # --- everything else: simple copy ---
        dst = os.path.join(out_dir, name)
        if not os.path.exists(dst):
            try:
                shutil.copyfile(src, dst)
            except OSError as e:
                print(f"[media] copy FAILED: {name} ({e})")
                continue

        manifest[name] = {
            "type": mtype,
            "src": "media/" + name,
            "transcoded": False,
        }

    print(f"[media] processed {len(manifest)} media files into {out_dir}")
    return manifest


if __name__ == "__main__":
    # Usage: python media.py <media_in> <site_out> [--no-transcode]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "site/media"
    transcode = "--no-transcode" not in sys.argv
    m = process_media(sys.argv[1], out_dir, transcode_opus=transcode)
    import json
    print(json.dumps(m, ensure_ascii=False, indent=2))