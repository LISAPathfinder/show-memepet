# 生成应用图标：取黑白线稿源图去底后输出多尺寸 .ico。
# 当前源图为透明底 PNG（icon-src.png，黑线白形角色）；白底 JPG 源（icon-src.jpg）
# 的去底流程保留在下方，换回白底图时把 SRC 指回去即可。
# 源图 1024x1024，先缩到 512 做去底与平滑，再逐级缩放；裁掉透明边并留内边距，
# 让小尺寸（托盘/任务栏 16~32px）下角色也占满、可辨认。
from PIL import Image, ImageDraw, ImageFilter
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'icon-src.png')
OUT_ICO = os.path.join(HERE, 'icon.ico')
OUT_PNG = os.path.join(HERE, 'icon-preview.png')
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
BIG = 512

im = Image.open(SRC).convert('RGBA')
im = im.resize((BIG, BIG), Image.LANCZOS)

# 去底：仅当四角不透明时才需要（白底/黑底 JPG 源）。透明底 PNG 四角 alpha=0
# 会自动跳过。白底源走 floodfill：thresh=150 连浅灰过渡带一起吃（thresh=90 时
# 165 亮度以下的白晕圈残留、缩放时污染黑线边缘，是 1.0.35 及更早「黑线边缘
# 发白」的主因之一）；填充色用黑——透明区 RGB 参与缩放插值，白色 RGB 混进半
# 透明边缘后在 Windows 预乘合成下泛白晕。
# 前提：源图衣服轮廓必须闭合到底——1.0.33 的源图毛衣与背景在底边连通，
# floodfill 曾顺缝吃掉整件毛衣；换源图前先用「floodfill 前后 alpha diff 可视化」
# 验证连通性，大块角色区误填需按图另行处理（见 git 历史里的多边形恢复方案）。
did_fill = False
for pt in [(0, 0), (BIG - 1, 0), (0, BIG - 1), (BIG - 1, BIG - 1)]:
    if im.getpixel(pt)[3] > 0:
        ImageDraw.floodfill(im, pt, (0, 0, 0, 0), thresh=150)
        did_fill = True

# alpha 开运算：清掉 floodfill 后边缘残留的白点（先腐蚀再膨胀）。仅白底源需要；
# 透明底源边缘干净，开运算反而会侵蚀细发丝。
if did_fill:
    a = im.getchannel('A').filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    im.putalpha(a)

# 透明区 RGB 洗黑：alpha=0 的像素不显示但参与缩放插值。comic-eyes 生成器输出的
# 透明区 RGB 全为白——混进黑线淡出边缘后，插值产物经下方 min(rgb,a) 只能压回
# 「预乘白」上界（淡出偏白雾）；洗成黑后边缘淡出走黑 matte（rgb≈0），线条锐利。
# 对线稿类透明底源恒正确：透明区没有视觉意义，RGB 归零不影响显示。
if not did_fill:
    px = im.load()
    for y in range(BIG):
        for x in range(BIG):
            if px[x, y][3] == 0 and px[x, y][:3] != (0, 0, 0):
                px[x, y] = (0, 0, 0, 0)

# 裁掉透明边，四周留 6% 内边距
im = im.crop(im.getbbox())
pad = int(max(im.size) * 0.06)
canvas = Image.new('RGBA', (max(im.size) + 2 * pad,) * 2, (0, 0, 0, 0))
canvas.alpha_composite(im, ((canvas.width - im.width) // 2, (canvas.height - im.height) // 2))
im = canvas.filter(ImageFilter.UnsharpMask(radius=2, percent=50, threshold=2))

im.resize((256, 256), Image.LANCZOS).save(OUT_PNG)

# 手工组装 ICO（BMP 帧），不用 Pillow 的 ico 编码器：实测 Pillow 12 无论 PNG 帧
# 还是 bitmap_format='bmp'，保存链路都会把帧数据归一化回直通形态，帧级写入的
# 矫正数据会被撤销。
#
# 帧级 rgb = min(rgb, a) 归一化：半透明像素 rgb 超过 a 就会在 Windows 预乘合成
# （display = rgb + (1-a)*bg）下超过「预乘白」的正确上界 a + (1-a)*bg，表现成
# 白晕。源图半透明像素混有两种合法语义——黑 matte（线条贴透明边的淡出，rgb≈0）
# 与预乘白（白形状淡出，rgb≈a）——min() 对二者都是恒等；只有直通白（rgb≈255）
# 等超界数据被压回上界。必须在缩放后的帧上做（源图级处理对帧里的混合产物无效，
# 1.0.36 实测教训）。
def save_ico_manual(img, path, sizes):
    import struct
    frames = []
    for w, h in sizes:
        f = img.resize((w, h), Image.LANCZOS)
        p = f.load()
        for y in range(h):
            for x in range(w):
                r, g, b, a = p[x, y]
                if a < 255:
                    p[x, y] = (min(r, a), min(g, a), min(b, a), a)
        px = bytearray()
        for y in range(h - 1, -1, -1):
            for x in range(w):
                r, g, b, a = p[x, y]
                px += struct.pack('BBBB', b, g, r, a)
        header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        mask_row = b'\x00' * (((w + 31) // 32) * 4)
        frames.append((w, h, header + bytes(px) + mask_row * h))
    out = struct.pack('<HHH', 0, 1, len(frames))
    entries = b''
    body = b''
    offset = 6 + 16 * len(frames)
    for w, h, blob in frames:
        entries += struct.pack('<BBBBHHII', w % 256, h % 256, 0, 0, 1, 32, len(blob), offset)
        body += blob
        offset += len(blob)
    with open(path, 'wb') as fp:
        fp.write(out + entries + body)

save_ico_manual(im, OUT_ICO, SIZES)
print('ICON_OK', os.path.getsize(OUT_ICO))
