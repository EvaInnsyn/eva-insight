"""
Resize Eva Insight eye assets.

Two sources, by design:
    sources/source-icon.png  — tight crop of just lid+iris (no dotted tails)
                                used for the Chrome toolbar icons (16/48/128)
                                so the eye fills the slot at small sizes.
    sources/source-full.png  — full eye with dotted-line tails, edge-to-edge
                                horizontally. Used for the side panel header
                                and empty-state hero where there's room for
                                the brand-handbook tail flourish.

Re-run after editing either source:

    python3 extension/scripts/generate-icons.py
"""

from __future__ import annotations

import os
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ICONS_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "public", "icons"))
PUBLIC_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "public"))

SOURCE_ICON = os.path.join(SCRIPT_DIR, "sources", "source-icon.png")
SOURCE_FULL = os.path.join(SCRIPT_DIR, "sources", "source-full.png")

ICON_SIZES = (16, 48, 128)


def resize(src: str, size: int, dest: str) -> None:
    subprocess.run(
        ["sips", "-z", str(size), str(size), src, "--out", dest],
        check=True,
        capture_output=True,
    )


def main() -> None:
    for path in (SOURCE_ICON, SOURCE_FULL):
        if not os.path.exists(path):
            raise SystemExit(f"missing source: {path}")

    # Manifest toolbar icons — tail-less so the eye dominates the slot.
    for size in ICON_SIZES:
        dest = os.path.join(ICONS_DIR, f"icon-{size}.png")
        resize(SOURCE_ICON, size, dest)
        print(f"wrote {dest} ({size}×{size})  [tail-less]")

    # Side panel header eye (rendered at 28px, sourced at 64 for crispness on retina)
    eye32 = os.path.join(PUBLIC_DIR, "eye-32.png")
    resize(SOURCE_FULL, 64, eye32)
    print(f"wrote {eye32} (64×64)  [with tails]")

    # Side panel empty-state hero
    eye_large = os.path.join(PUBLIC_DIR, "eye-large.png")
    subprocess.run(
        ["sips", "-Z", "256", SOURCE_FULL, "--out", eye_large],
        check=True, capture_output=True,
    )
    print(f"wrote {eye_large} (≤256px)  [with tails]")


if __name__ == "__main__":
    main()
