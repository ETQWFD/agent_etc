#!/usr/bin/env python3
"""生成 agent_etc 的图标：纯黑圆角方块 + 中间镂空的透明 A。"""

from PIL import Image, ImageDraw, ImageFont

S = 1024
RADIUS = 208
BLACK = (0, 0, 0, 255)

canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 黑色圆角底板
plate = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(plate)
d.rounded_rectangle([(0, 0), (S - 1, S - 1)], radius=RADIUS, fill=BLACK)
# 内描边，让纯黑在纯黑背景上仍有轮廓
d.rounded_rectangle([(7, 7), (S - 8, S - 8)], radius=RADIUS - 7, outline=(26, 26, 26, 255), width=6)

# A 字形的镂空遮罩
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 640)
text = "A"
bbox = md.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
md.text(((S - tw) / 2 - bbox[0], (S - th) / 2 - bbox[1] - 10), text, font=font, fill=255)

# 把 A 从底板上挖掉：alpha 相减
alpha = plate.split()[3]
new_alpha = Image.eval(alpha, lambda a: a)
new_alpha = Image.composite(Image.new("L", (S, S), 0), new_alpha, mask)
plate.putalpha(new_alpha)

canvas.alpha_composite(plate)
canvas.save("build/icon.png")
canvas.resize((512, 512), Image.LANCZOS).save("build/icon-512.png")

sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
canvas.resize((256, 256), Image.LANCZOS).save("build/icon.ico", sizes=sizes)
print("生成完成：build/icon.png / build/icon.ico")
