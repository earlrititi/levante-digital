"""Convert the supplied raster/SVG wrappers, preserving SVG crop and opacity.

Requires Pillow. Originals are retained. These SVGs wrap embedded PNGs;
unsupported SVG structures fail rather than silently changing the artwork.
"""
from pathlib import Path
from PIL import Image
import base64
import io
import json
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "public/assets/images"
SVG = "{http://www.w3.org/2000/svg}"
XLINK = "{http://www.w3.org/1999/xlink}"
ASSETS = [
    ("fondo hero.svg", "fondo-hero.webp", False),
    ("noise hero.svg", "noise-hero.webp", False),
    ("Marco Hero.png", "marco-hero.webp", True),
    ("marco.svg", "marco.webp", True),
    ("Logo Hero.svg", "logo-hero.webp", True),
    ("cortina.svg", "cortina.webp", True),
    ("fondo def.png", "fondo-def.webp", False),
    ("cortina_def.png", "cortina-def.webp", True),
]

def load(source):
    if source.suffix != ".svg":
        return Image.open(source).convert("RGBA")
    root = ET.parse(source).getroot()
    image_nodes = root.findall(SVG + "image")
    if len(image_nodes) != 1 or root.findall(SVG + "path"):
        raise ValueError(f"Unsupported SVG artwork: {source.name}")
    node = image_nodes[0]
    href = node.get(XLINK + "href") or node.get("href", "")
    if not href.startswith("data:"):
        raise ValueError("Expected an embedded PNG")
    raster = Image.open(io.BytesIO(base64.b64decode(href.split(",", 1)[1]))).convert("RGBA")
    size = (int(float(node.get("width"))), int(float(node.get("height"))))
    if raster.size != size:
        raster = raster.resize(size, Image.Resampling.LANCZOS)
    # The supplied noise SVG applies .cls-1 { opacity: 0.4 } on top of PNG alpha.
    opacity = float(node.get("opacity", "0.4" if node.get("class") == "cls-1" else "1"))
    if opacity != 1:
        raster.putalpha(raster.getchannel("A").point(lambda a: round(a * opacity)))
    canvas = Image.new("RGBA", (int(root.get("width")), int(root.get("height"))))
    canvas.alpha_composite(raster, (round(float(node.get("x", 0))), round(float(node.get("y", 0)))))
    return canvas

report = []
for original, destination, lossless in ASSETS:
    source, output = IMAGES / original, IMAGES / destination
    im = load(source)
    # Discard invisible RGB data; the frame PNG stores a full photo under alpha=0.
    # Alpha and every visible pixel remain unchanged, with much smaller WebP output.
    if lossless:
        pixels = list(im.get_flattened_data())
        im.putdata([(0, 0, 0, 0) if a == 0 else (r, g, b, a) for r, g, b, a in pixels])
    im.save(output, "WEBP", lossless=lossless, quality=88, method=6, exact=True)
    decoded = Image.open(output).convert("RGBA")
    if decoded.size != im.size or decoded.getchannel("A").tobytes() != im.getchannel("A").tobytes():
        raise AssertionError(f"Dimensions or alpha changed: {destination}")
    if lossless and decoded.tobytes() != im.tobytes():
        raise AssertionError(f"Visible colors changed: {destination}")
    report.append({"source": original, "webp": destination, "width": im.width,
                   "height": im.height, "originalBytes": source.stat().st_size,
                   "webpBytes": output.stat().st_size, "lossless": lossless,
                   "alphaVerified": True})
(IMAGES / "conversion.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
for asset in report:
    print(f"{asset['webp']}: {asset['width']}x{asset['height']}, {asset['webpBytes']:,} bytes, alpha OK")
