"""Generate the extension icons and local test images."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
TEST = ROOT / "test"
ICONS.mkdir(parents=True, exist_ok=True)
TEST.mkdir(parents=True, exist_ok=True)

S = 1024


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGB", (1, height))
    pixels = image.load()
    for y in range(height):
        t = y / max(1, height - 1)
        pixels[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return image.resize((width, height), Image.Resampling.NEAREST)


def make_icon() -> None:
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    radius = 224
    plate = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    plate_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(plate_mask).rounded_rectangle((26, 26, S - 26, S - 26), radius=radius, fill=255)

    background = vertical_gradient((S, S), (30, 35, 47), (9, 11, 16)).convert("RGBA")
    plate.paste(background, (0, 0), plate_mask)

    # Soft top glow.
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((80, -260, 900, 560), fill=(86, 101, 132, 80))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    plate.alpha_composite(Image.composite(glow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), plate_mask))

    border = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        (26, 26, S - 26, S - 26), radius=radius, outline=(255, 255, 255, 30), width=3
    )
    plate.alpha_composite(border)

    # Crescent mask: one circle minus another.
    moon = Image.new("L", (S, S), 0)
    draw = ImageDraw.Draw(moon)
    draw.ellipse((248, 268, 776, 796), fill=255)
    draw.ellipse((360, 290, 888, 818), fill=0)

    amber = vertical_gradient((S, S), (255, 231, 176), (232, 164, 54)).convert("RGBA")

    halo = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    halo.putalpha(moon.filter(ImageFilter.GaussianBlur(46)).point(lambda v: int(v * 0.45)))
    halo = Image.composite(
        Image.new("RGBA", (S, S), (245, 180, 70, 110)), Image.new("RGBA", (S, S), (0, 0, 0, 0)), halo.getchannel("A")
    )
    plate.alpha_composite(halo.filter(ImageFilter.GaussianBlur(16)))

    moon_layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    moon_layer.paste(amber, (0, 0), moon)
    plate.alpha_composite(moon_layer)

    # A few restrained stars.
    stars = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    star_draw = ImageDraw.Draw(stars)
    for x, y, r, alpha in [(760, 252, 9, 150), (826, 358, 5, 110), (700, 158, 4, 90), (862, 520, 3, 70)]:
        star_draw.ellipse((x - r, y - r, x + r, y + r), fill=(255, 232, 186, alpha))
    plate.alpha_composite(stars)

    for size in (16, 32, 48, 128, 256):
        resized = plate.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(ICONS / f"icon{size}.png")


def make_photo() -> None:
    width, height = 1200, 800
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    horizon = int(height * 0.58)
    for y in range(height):
        if y < horizon:
            t = y / horizon
            top = (43, 34, 78)
            bottom = (244, 151, 104)
            color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        else:
            t = (y - horizon) / (height - horizon)
            top = (188, 112, 92)
            bottom = (35, 33, 58)
            color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(width):
            pixels[x, y] = color

    draw = ImageDraw.Draw(image, "RGBA")
    # Sun and its reflection.
    draw.ellipse((790, 250, 990, 450), fill=(255, 214, 150, 255))
    draw.ellipse((760, 220, 1020, 480), fill=(255, 199, 128, 46))
    for i in range(18):
        y = horizon + 18 + i * 17
        half = 40 + i * 13
        alpha = max(8, 90 - i * 5)
        draw.rounded_rectangle((890 - half, y, 890 + half, y + 4), radius=2, fill=(255, 205, 150, alpha))

    # Layered hills.
    draw.polygon([(0, 560), (210, 380), (430, 560), (620, 430), (860, 590), (1040, 470), (1200, 560), (1200, 800), (0, 800)], fill=(53, 46, 82, 255))
    draw.polygon([(0, 650), (260, 500), (470, 650), (720, 520), (980, 660), (1200, 570), (1200, 800), (0, 800)], fill=(34, 32, 58, 255))
    draw.polygon([(0, 730), (180, 650), (400, 740), (680, 640), (920, 750), (1200, 690), (1200, 800), (0, 800)], fill=(18, 19, 36, 255))

    # Tiny birds.
    for x, y, s in [(300, 210, 12), (350, 190, 8), (390, 225, 10)]:
        draw.arc((x - s, y - s, x, y + s), 200, 340, fill=(30, 26, 42, 190), width=3)
        draw.arc((x, y - s, x + s, y + s), 200, 340, fill=(30, 26, 42, 190), width=3)

    image = image.filter(ImageFilter.GaussianBlur(0.4))
    image.save(TEST / "photo.jpg", quality=90, optimize=True)


def make_avatar() -> None:
    size = 240
    image = Image.new("RGB", (size, size), (225, 187, 148))
    draw = ImageDraw.Draw(image)
    draw.ellipse((-40, 80, 280, 360), fill=(74, 102, 120))
    draw.ellipse((52, 36, 188, 176), fill=(245, 206, 168))
    draw.ellipse((58, 64, 92, 88), fill=(53, 42, 36))
    draw.ellipse((148, 64, 182, 88), fill=(53, 42, 36))
    draw.arc((86, 108, 154, 156), 15, 165, fill=(120, 70, 62), width=6)
    draw.ellipse((36, 116, 70, 196), fill=(53, 42, 36))
    draw.ellipse((170, 116, 204, 196), fill=(53, 42, 36))
    image.save(TEST / "avatar.jpg", quality=90, optimize=True)


if __name__ == "__main__":
    make_icon()
    make_photo()
    make_avatar()
    print("assets written")
