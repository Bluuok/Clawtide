"""Encode browser-rendered frames, without altering the original artwork.

Usage: python scripts/encode-hero.py <frames-directory> <output.gif>
"""
import sys
from pathlib import Path
from PIL import Image

paths = sorted(Path(sys.argv[1]).glob('*.png'))
frames = [Image.open(path).convert('RGB') for path in paths]
# One shared palette keeps the static artwork stable throughout the animation.
palette = frames[0].quantize(colors=256)
indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
destination = Path(sys.argv[2])
destination.parent.mkdir(parents=True, exist_ok=True)
indexed[0].save(destination, save_all=True, append_images=indexed[1:],
                duration=[1800 if '-hold' in p.stem else 110 for p in paths],
                loop=0, optimize=True, disposal=1)
print(f'{destination}: {destination.stat().st_size} bytes, {len(frames)} frames')
