#!/usr/bin/env python3
"""
Script de impachetare One-Click:
1. Genereaza `dist/legislatie-ro.mcpb` — Pachetul One-Click Install pentru Claude Desktop
2. Genereaza `dist/legislatie-ro-browser-extension.zip` — Pachetul pentru Chrome / Edge / Brave / Firefox
"""

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)


def build_mcpb() -> Path:
    out_path = DIST / "legislatie-ro.mcpb"
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in ["manifest.json", "server.py", "README.md", "LICENSE"]:
            zf.write(ROOT / fname, arcname=fname)
    return out_path


def build_browser_zip() -> Path:
    out_path = DIST / "legislatie-ro-browser-extension.zip"
    ext_dir = ROOT / "browser-extension"
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(ext_dir.rglob("*")):
            if file_path.is_file():
                zf.write(file_path, arcname=str(file_path.relative_to(ext_dir)))
    return out_path


if __name__ == "__main__":
    p1 = build_mcpb()
    p2 = build_browser_zip()
    print(f"Creat pachet One-Click Claude Desktop (.mcpb): {p1} ({p1.stat().st_size} bytes)")
    print(f"Creat pachet Extensie Browser (.zip):          {p2} ({p2.stat().st_size} bytes)")
