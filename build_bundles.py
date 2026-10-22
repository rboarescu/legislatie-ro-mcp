#!/usr/bin/env python3
"""
Impacheteaza `skills/legislatie-ro-skill.zip` (gata de incarcat cu 1 click in Claude.ai -> Settings -> Capabilities -> Skills)
precum si `dist/legislatie-ro.mcpb` si `dist/legislatie-ro-browser-extension.zip`.
"""

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)


def build_skill_zip() -> Path:
    out_path = DIST / "legislatie-ro-skill.zip"
    skills_dir = ROOT / "skills"
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(skills_dir.rglob("*")):
            if file_path.is_file():
                zf.write(
                    file_path,
                    arcname=str(Path("legislatie-ro") / file_path.relative_to(skills_dir)),
                )
    return out_path


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
    p_skill = build_skill_zip()
    p_mcpb = build_mcpb()
    p_ext = build_browser_zip()
    print(f"1. Pachet Custom Skill (Claude Web/Mobile & Gemini Gems): {p_skill} ({p_skill.stat().st_size} bytes)")
    print(f"2. Pachet Claude Desktop (.mcpb):                         {p_mcpb} ({p_mcpb.stat().st_size} bytes)")
    print(f"3. Pachet Extensie Browser (.zip):                        {p_ext} ({p_ext.stat().st_size} bytes)")
