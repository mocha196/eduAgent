"""Check if a specific image SHA exists in material_images and chunks tables."""
import os, sys
from dotenv import load_dotenv

load_dotenv("edu-platform/.env.local", override=False)
load_dotenv(".env", override=False)

SHA = "fce82d86b221f5716dff50801f04e999d2cdd0b7e39375186c5661e2203f50d0"

import psycopg

dsn = (
    os.environ.get("DATABASE_URL")
    or os.environ.get("POSTGRES_URL")
    or os.environ.get("DIRECT_URL")
)
print("Connecting to DB...")

with psycopg.connect(dsn) as conn:
    with conn.cursor() as cur:
        # 1. 在 material_images 中找 minio_url 含有该 sha 的记录
        cur.execute(
            "SELECT id, material_id, page_idx, minio_url FROM material_images WHERE minio_url LIKE %s LIMIT 10",
            (f"%{SHA[:20]}%",),
        )
        rows = cur.fetchall()
        print(f"\n[material_images] rows matching SHA prefix '{SHA[:20]}':")
        if rows:
            for r in rows:
                print(f"  id={r[0]}  material_id={r[1]}  page_idx={r[2]}")
                print(f"  url={r[3]}")
        else:
            print("  (none)")

        # 2. 在 chunks 中找 content 含有该文件名的记录
        cur.execute(
            "SELECT chunk_id, material_id, content FROM chunks WHERE content LIKE %s LIMIT 5",
            (f"%{SHA[:20]}%",),
        )
        rows2 = cur.fetchall()
        print(f"\n[chunks] rows with SHA in content:")
        if rows2:
            for r in rows2:
                print(f"  chunk_id={r[0]}  material_id={r[1]}")
                print(f"  content={r[2][:200]}")
        else:
            print("  (none)")

        # 3. 查看 material_images 的样本，了解 URL 格式
        cur.execute("SELECT minio_url FROM material_images LIMIT 3")
        samples = cur.fetchall()
        print(f"\n[material_images] sample URLs:")
        for s in samples:
            print(f"  {s[0]}")

        # 4. 查该 SHA 对应的 CDN URL 能否在 material_images 中找到
        cdn_url = f"https://cdn-mineru.openxlab.org.cn/result"
        cur.execute(
            "SELECT COUNT(*) FROM material_images WHERE minio_url LIKE %s",
            (f"%cdn-mineru%",),
        )
        cdn_count = cur.fetchone()[0]
        print(f"\n[material_images] CDN-mineru URLs count: {cdn_count}")

        # 5. 直接找该文件名
        cur.execute(
            "SELECT minio_url FROM material_images WHERE minio_url LIKE %s LIMIT 5",
            (f"%{SHA}%",),
        )
        exact = cur.fetchall()
        print(f"\n[material_images] exact SHA match:")
        if exact:
            for e in exact:
                print(f"  {e[0]}")
        else:
            print("  (none — SHA not in minio_url)")
