import re
import struct
import sys
import os

def parse_ascii_stl(path):
    verts = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if line.startswith("vertex"):
                parts = line.split()
                x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
                verts.append((x, y, z))
    return verts

def parse_binary_stl(path):
    verts = []
    with open(path, "rb") as f:
        f.read(80)
        (n_tris,) = struct.unpack("<I", f.read(4))
        for _ in range(n_tris):
            data = f.read(50)
            if len(data) < 50:
                break
            floats = struct.unpack("<12fH", data)
            for i in range(3):
                x, y, z = floats[3 + i * 3 : 6 + i * 3]
                verts.append((x, y, z))
    return verts

def is_binary_stl(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.read(80)
        rest = f.read(4)
        if len(rest) < 4:
            return False
        (n_tris,) = struct.unpack("<I", rest)
    expected_size = 84 + n_tris * 50
    return expected_size == size

def bbox(verts):
    xs = [v[0] for v in verts]
    ys = [v[1] for v in verts]
    zs = [v[2] for v in verts]
    return (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))

folder = sys.argv[1]
for fname in sorted(os.listdir(folder)):
    if not fname.lower().endswith(".stl"):
        continue
    path = os.path.join(folder, fname)
    binary = is_binary_stl(path)
    verts = parse_binary_stl(path) if binary else parse_ascii_stl(path)
    if not verts:
        print(f"{fname}: NO VERTICES PARSED (binary={binary})")
        continue
    xmin, xmax, ymin, ymax, zmin, zmax = bbox(verts)
    print(f"{fname}: format={'binary' if binary else 'ascii'} n_verts={len(verts)}")
    print(f"  X: {xmin:.3f} to {xmax:.3f} (span {xmax-xmin:.3f} mm)")
    print(f"  Y: {ymin:.3f} to {ymax:.3f} (span {ymax-ymin:.3f} mm)")
    print(f"  Z: {zmin:.3f} to {zmax:.3f} (span {zmax-zmin:.3f} mm)")
