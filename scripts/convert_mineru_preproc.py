"""Convert MinerU preproc-blocks JSON to content_list format for LightRAG ingest.

MinerU cloud sometimes saves the raw preproc format:
  { "pdf_info": [ { "preproc_blocks": [ {type, lines:[{spans:[{content|image_path}]}] } ] } ] }

This script converts it to the flat content_list format that RAGAnything / reindex_from_cache expects:
  [ {type:"text", text:"...", page_idx:N}, {type:"image", img_path:"...", page_idx:N}, ... ]

Usage:
  python scripts/convert_mineru_preproc.py                          # convert all MinerU_*.json in output/parsed/
  python scripts/convert_mineru_preproc.py output/parsed/MinerU_X.json  # single file
  python scripts/convert_mineru_preproc.py --ingest                 # convert + immediately ingest into LightRAG
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _spans_text(spans: list[dict]) -> str:
    parts = []
    for sp in spans:
        c = sp.get("content") or sp.get("text") or ""
        if isinstance(c, str) and c.strip():
            parts.append(c.strip())
    return " ".join(parts)


def _extract_image_path(spans: list[dict]) -> str | None:
    for sp in spans:
        if sp.get("type") == "image":
            return sp.get("image_path") or sp.get("img_path")
    return None


def _extract_nested_img_path(block: dict) -> str | None:
    """Extract CDN image_path from block.blocks[].lines[].spans[] (image/table/chart structure)."""
    for sub in block.get("blocks", []):
        for line in sub.get("lines", []):
            for sp in line.get("spans", []):
                v = sp.get("image_path") or sp.get("img_path")
                if v:
                    return v
    return None


def _extract_nested_text(block: dict) -> str:
    """Collect all text content from block.blocks[].lines[].spans[].content."""
    parts: list[str] = []
    for sub in block.get("blocks", []):
        for line in sub.get("lines", []):
            t = _spans_text(line.get("spans", []))
            if t:
                parts.append(t)
    return "\n".join(parts).strip()


def _extract_caption_from_blocks(block: dict, caption_sub_type: str) -> str:
    """Extract caption text from a named sub-block (e.g. 'chart_caption', 'table_caption')."""
    for sub in block.get("blocks", []):
        if sub.get("type") == caption_sub_type:
            parts: list[str] = []
            for line in sub.get("lines", []):
                t = _spans_text(line.get("spans", []))
                if t:
                    parts.append(t)
            return " ".join(parts).strip()
    return ""


def convert_preproc_json(src: Path) -> list[dict]:
    """Convert a single MinerU preproc JSON file to content_list format."""
    data = json.loads(src.read_text(encoding="utf-8"))

    # Detect format
    if isinstance(data, list):
        # Already content_list format
        return data

    pdf_info: list[dict] = data.get("pdf_info", [])
    if not pdf_info:
        raise ValueError(f"No 'pdf_info' key found in {src.name}")

    content_list: list[dict] = []

    for page_idx, page in enumerate(pdf_info):
        blocks: list[dict] = page.get("preproc_blocks", [])
        for block in blocks:
            btype: str = block.get("type", "text")

            # ── image ────────────────────────────────────────────────────────
            if btype == "image":
                img_path = _extract_nested_img_path(block)
                if img_path:
                    content_list.append({"type": "image", "img_path": img_path, "page_idx": page_idx})

            # ── table — rendered as image by MinerU cloud ────────────────────
            # Output as type=image so the VLM can read the table's visual content.
            elif btype == "table":
                img_path = _extract_nested_img_path(block)
                if img_path:
                    caption = _extract_caption_from_blocks(block, "table_caption")
                    item: dict = {"type": "image", "img_path": img_path, "page_idx": page_idx}
                    if caption:
                        item["img_caption"] = [caption]
                    content_list.append(item)

            # ── chart — rendered as image by MinerU cloud ────────────────────
            elif btype == "chart":
                img_path = _extract_nested_img_path(block)
                if img_path:
                    caption = _extract_caption_from_blocks(block, "chart_caption")
                    item = {"type": "image", "img_path": img_path, "page_idx": page_idx}
                    if caption:
                        item["img_caption"] = [caption]
                    content_list.append(item)

            # ── code ─────────────────────────────────────────────────────────
            elif btype == "code":
                code_text = _extract_nested_text(block)
                if code_text:
                    content_list.append({
                        "type": "code",
                        "text": code_text,
                        "language": block.get("guess_lang", ""),
                        "page_idx": page_idx,
                    })

            else:
                # text / title / list / interline_equation
                # These blocks use top-level block.lines[] (no nesting)
                lines: list[dict] = block.get("lines", [])
                texts = [_spans_text(line.get("spans", [])) for line in lines]
                full_text = "\n".join(t for t in texts if t).strip()
                if not full_text:
                    continue
                item = {"type": "text", "text": full_text, "page_idx": page_idx}
                if btype == "title":
                    item["text_level"] = 1
                elif btype == "interline_equation":
                    item["type"] = "equation"
                content_list.append(item)

    return content_list


def convert_and_save(src: Path, out_dir: Path | None = None) -> Path:
    """Convert src → content_list.json and save alongside (or in out_dir)."""
    content_list = convert_preproc_json(src)

    dest_dir = out_dir if out_dir else src.parent
    dest_dir.mkdir(parents=True, exist_ok=True)

    stem = src.stem  # e.g. MinerU_计算机网络自顶向下第八版英文PDF-1-199__20260519044058
    dest = dest_dir / f"{stem}_content_list.json"
    dest.write_text(json.dumps(content_list, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[convert] {src.name}  →  {dest} ({len(content_list)} blocks)")
    return dest


def find_preproc_files(scan_dir: Path) -> list[Path]:
    return sorted(scan_dir.glob("MinerU_*.json"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert MinerU preproc JSON → content_list for LightRAG")
    parser.add_argument(
        "files",
        nargs="*",
        help="One or more MinerU_*.json files (default: all in output/parsed/)",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help="Output directory for content_list files (default: same folder as source)",
    )
    parser.add_argument(
        "--ingest",
        action="store_true",
        help="After conversion, immediately ingest into LightRAG via reindex_from_cache",
    )
    args = parser.parse_args()

    base_dir = Path(__file__).parent.parent / "output" / "parsed"

    if args.files:
        sources = [Path(f) for f in args.files]
    else:
        sources = find_preproc_files(base_dir)

    if not sources:
        print("No MinerU_*.json files found.", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.out_dir) if args.out_dir else None
    converted: list[Path] = []
    for src in sources:
        try:
            dest = convert_and_save(src, out_dir)
            converted.append(dest)
        except Exception as exc:
            print(f"[error] {src.name}: {exc}", file=sys.stderr)

    print(f"\nConverted {len(converted)}/{len(sources)} file(s).")

    if args.ingest and converted:
        print("\nIngesting into LightRAG …")
        # Add project root to sys.path so rag_mvp can be imported
        sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
        from rag_mvp.engine import get_rag, _ensure_lightrag_storages, _fix_image_paths
        import asyncio

        rag = get_rag()

        async def _do_ingest():
            await _ensure_lightrag_storages(rag)
            for dest in converted:
                raw = json.loads(dest.read_text(encoding="utf-8"))
                content_list = _fix_image_paths(raw, dest.parent)
                stem = dest.stem.replace("_content_list", "")
                await rag.insert_content_list(content_list, file_path=stem)
                print(f"[ingest] {stem} ({len(content_list)} blocks) ✓")

        asyncio.run(_do_ingest())
        print("Ingest complete.")


if __name__ == "__main__":
    main()
