"""Build the GitHub Pages site from the same CSVs as the CloudBase app."""

import json
import shutil
from pathlib import Path

from serve import HERE, PAGE, load


def write_json(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main():
    poems, dataset = load(HERE / "data")
    dataset["generation"] = False
    output = HERE / "docs"
    data_dir = output / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    write_json(data_dir / "matches.json", dataset)
    for poet, slug in {"李白": "libai", "杜甫": "dufu", "孟浩然": "menghaoran"}.items():
        write_json(data_dir / f"{slug}.json", {
            work: [[index, lines[index][1]] for index in sorted(lines)]
            for work, lines in poems[poet].items()
        })

    for name in ("app.js", "style.css", "cover.png", "wine-scroll.webp",
                 "autumn-wind.webp", "river-characters.webp"):
        shutil.copyfile(HERE / name, output / name)
    html = (HERE / PAGE[0]).read_text(encoding="utf-8")
    html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-runtime="static">', 1)
    (output / "index.html").write_text(html, encoding="utf-8")
    (output / ".nojekyll").touch()
    count = sum(len(group["matches"]) for group in dataset["groups"].values())
    print(f"已导出 {count:,} 条句对及原诗：{output}")


if __name__ == "__main__":
    main()
