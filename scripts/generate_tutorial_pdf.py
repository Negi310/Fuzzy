from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf"
MAIN_SCREENSHOT_PATH = ROOT / "assets" / "tutorial" / "main-window.png"
OUTPUT_PATH = ROOT / "docs" / "Fuzitter_Tutorial.pdf"
PAGE1_PNG = OUTPUT_DIR / "fuzitter-tutorial-page-1.png"
PAGE2_PNG = OUTPUT_DIR / "fuzitter-tutorial-page-2.png"

PAGE_W = 1654
PAGE_H = 2339
MARGIN = 82

HEADER = "#1f3b63"
TEXT = "#213247"
SUBTLE = "#5e7188"
PANEL = "#eef4fb"
LINE = "#d2dceb"
ACCENT = "#0f7490"
BG = "#f7f9fc"
WHITE = "#ffffff"

FONT_REGULAR = r"C:\Windows\Fonts\BIZ-UDGothicR.ttc"
FONT_BOLD = r"C:\Windows\Fonts\BIZ-UDGothicB.ttc"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def text_block(
    draw: ImageDraw.ImageDraw,
    text: str,
    xy: tuple[int, int],
    max_width: int,
    *,
    fill: str = TEXT,
    size: int = 26,
    bold: bool = False,
    line_gap: int = 10,
) -> int:
    x, y = xy
    active_font = font(size, bold=bold)
    lines: list[str] = []
    current = ""

    for char in text:
        candidate = current + char
        width = draw.textbbox((0, 0), candidate, font=active_font)[2]
        if width <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = char

    if current:
        lines.append(current)

    for line in lines:
        draw.text((x, y), line, fill=fill, font=active_font)
        y += size + line_gap
    return y


def rounded_box(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    *,
    fill: str,
    outline: str | None = None,
    width: int = 1,
    radius: int = 24,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def page_base() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (PAGE_W, PAGE_H), BG)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, PAGE_W, 124), fill=HEADER)
    draw.text((MARGIN, 44), "Fuzitter チュートリアル", fill=WHITE, font=font(42, bold=True))
    return image, draw


def add_page_number(draw: ImageDraw.ImageDraw, label: str) -> None:
    bbox = draw.textbbox((0, 0), label, font=font(18))
    draw.text(
        (PAGE_W - MARGIN - (bbox[2] - bbox[0]), PAGE_H - 50),
        label,
        fill=SUBTLE,
        font=font(18),
    )


def paste_screenshot(base: Image.Image, source_path: Path, target_box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = target_box
    framed = Image.new("RGB", (x2 - x1, y2 - y1), WHITE)
    if source_path.exists():
        screenshot = Image.open(source_path).convert("RGB")
        screenshot.thumbnail((x2 - x1 - 16, y2 - y1 - 16))
        ox = (framed.width - screenshot.width) // 2
        oy = (framed.height - screenshot.height) // 2
        framed.paste(screenshot, (ox, oy))
    base.paste(framed, (x1, y1))


def chip(draw: ImageDraw.ImageDraw, text: str, x: int, y: int) -> int:
    active_font = font(18, bold=True)
    bbox = draw.textbbox((0, 0), text, font=active_font)
    width = (bbox[2] - bbox[0]) + 28
    rounded_box(draw, (x, y, x + width, y + 38), fill="#eaf2ff", radius=18)
    draw.text((x + 14, y + 8), text, fill="#1f5fbf", font=active_font)
    return width


def callout(draw: ImageDraw.ImageDraw, number: str, title: str, body: str, x: int, y: int, w: int, h: int) -> None:
    rounded_box(draw, (x, y, x + w, y + h), fill=WHITE, outline=LINE, width=2, radius=20)
    draw.ellipse((x + 18, y + 18, x + 56, y + 56), fill=ACCENT)
    number_bbox = draw.textbbox((0, 0), number, font=font(18, bold=True))
    draw.text(
        (x + 37 - (number_bbox[2] - number_bbox[0]) / 2, y + 25),
        number,
        fill=WHITE,
        font=font(18, bold=True),
    )
    draw.text((x + 72, y + 18), title, fill=HEADER, font=font(21, bold=True))
    text_block(draw, body, (x + 18, y + 62), w - 36, size=18, line_gap=6)


def info_box(draw: ImageDraw.ImageDraw, title: str, body: str, x: int, y: int, w: int, h: int) -> None:
    rounded_box(draw, (x, y, x + w, y + h), fill=WHITE, outline=LINE, width=2, radius=20)
    rounded_box(draw, (x + 10, y + 10, x + w - 10, y + 60), fill=PANEL, radius=14)
    draw.text((x + 20, y + 18), title, fill=HEADER, font=font(22, bold=True))
    text_block(draw, body, (x + 20, y + 78), w - 40, size=20, line_gap=8)


def build_page_one() -> Image.Image:
    image, draw = page_base()
    y = 180
    draw.text((MARGIN, y), "この画面で使えること", fill=HEADER, font=font(38, bold=True))
    y += 66
    y = text_block(
        draw,
        "Fuzitter は左側で Moodle を見ながら、右側でエクスプローラーとタイムラインをまとめて扱えるアプリです。まずは画面の見方をつかむと、提出や資料整理の流れがかなり分かりやすくなります。",
        (MARGIN, y),
        PAGE_W - MARGIN * 2,
        size=24,
        line_gap=8,
    ) + 12

    next_x = MARGIN
    next_x += chip(draw, "左: Moodle を見る", next_x, y)
    next_x += 14
    next_x += chip(draw, "右: ファイルを整理する", next_x, y)
    next_x += 14
    chip(draw, "右下の ? から再確認", next_x, y)
    y += 58

    shot_box = (MARGIN, y, PAGE_W - MARGIN, y + 880)
    rounded_box(draw, shot_box, fill=WHITE, outline=LINE, width=3, radius=28)
    paste_screenshot(image, MAIN_SCREENSHOT_PATH, (shot_box[0] + 8, shot_box[1] + 8, shot_box[2] - 8, shot_box[3] - 8))
    y = shot_box[3] + 30

    gap = 22
    box_w = (PAGE_W - MARGIN * 2 - gap) // 2
    box_h = 200
    callout(
        draw,
        "1",
        "チュートリアルボタン",
        "アドレスバー右の ? から、このチュートリアル PDF をいつでも開けます。",
        MARGIN,
        y,
        box_w,
        box_h,
    )
    callout(
        draw,
        "2",
        "コースページと提出フォルダ",
        "右上のボタンは現在のコースに合わせて動きます。コースページを開いたり、対応する提出フォルダへ移動したりできます。",
        MARGIN + box_w + gap,
        y,
        box_w,
        box_h,
    )
    y += box_h + 20
    callout(
        draw,
        "3",
        "右側のエクスプローラー",
        "ダウンロードした資料や自分の提出物を整理する場所です。コースに合わせたフォルダへすぐ移動できます。",
        MARGIN,
        y,
        box_w,
        box_h,
    )
    callout(
        draw,
        "4",
        "タイムライン切り替え",
        "右上のタブでタイムラインへ切り替えると、課題や提出の流れを確認しながら移動できます。",
        MARGIN + box_w + gap,
        y,
        box_w,
        box_h,
    )

    add_page_number(draw, "1 / 2")
    return image


def build_page_two() -> Image.Image:
    image, draw = page_base()
    y = 180
    draw.text((MARGIN, y), "連携している機能", fill=HEADER, font=font(38, bold=True))
    y += 66
    y = text_block(
        draw,
        "Fuzitter はただ Moodle を見るだけではなく、見ているページと右側の操作をつなげて使えるのが特徴です。特に次の 2 つを覚えると、提出準備がかなり楽になります。",
        (MARGIN, y),
        PAGE_W - MARGIN * 2,
        size=24,
        line_gap=8,
    ) + 18

    top_h = 300
    gap = 24
    half_w = (PAGE_W - MARGIN * 2 - gap) // 2
    info_box(
        draw,
        "コースページと開いたフォルダの連携",
        "左でコースページを開いた状態で右の提出フォルダを開くと、そのコースに対応する保存先へ移動できます。コースページを開きつつ資料整理や提出ファイルの準備を続けられます。",
        MARGIN,
        y,
        half_w,
        top_h,
    )
    info_box(
        draw,
        "タイムラインと提出画面の連携",
        "タイムラインに表示された提出物や課題を選ぶと、対応する提出画面へ移動しやすくなります。提出先の確認からアップロードまで迷いにくくするための連携です。",
        MARGIN + half_w + gap,
        y,
        half_w,
        top_h,
    )
    y += top_h + 28

    draw.text((MARGIN, y), "画面イメージ", fill=HEADER, font=font(34, bold=True))
    y += 52
    shot_box = (MARGIN, y, PAGE_W - MARGIN, y + 760)
    rounded_box(draw, shot_box, fill=WHITE, outline=LINE, width=3, radius=28)
    paste_screenshot(image, MAIN_SCREENSHOT_PATH, (shot_box[0] + 8, shot_box[1] + 8, shot_box[2] - 8, shot_box[3] - 8))

    note_y = shot_box[3] + 24
    callout(
        draw,
        "A",
        "コースを開いてから操作する",
        "左の Moodle と右のフォルダを対応づけながら整理すると、どの授業の資料かを見失いにくくなります。",
        MARGIN,
        note_y,
        half_w,
        170,
    )
    callout(
        draw,
        "B",
        "提出前にタイムラインも確認",
        "提出フォルダを開いたあとにタイムラインを見ると、課題の締切や提出画面にもそのまま移動しやすくなります。",
        MARGIN + half_w + gap,
        note_y,
        half_w,
        170,
    )

    add_page_number(draw, "2 / 2")
    return image


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    pages = [
        (build_page_one(), PAGE1_PNG),
        (build_page_two(), PAGE2_PNG),
    ]
    pdf = canvas.Canvas(str(OUTPUT_PATH), pagesize=A4)
    for image, page_path in pages:
        image.save(page_path)
        pdf.drawImage(ImageReader(str(page_path)), 0, 0, width=A4[0], height=A4[1])
        pdf.showPage()
    pdf.save()
    print(OUTPUT_PATH)


if __name__ == "__main__":
    main()
