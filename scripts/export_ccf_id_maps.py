#!/usr/bin/env python3
"""
export_ccf_id_maps.py
=====================
Exports per-coronal-slice structure-ID maps (PNG, ID packed into RGB) plus
id_to_acronym.json, so the viewer can resolve a click to the EXACT CCF
structure instead of guessing from midline centroids.

Encoding:  R = id >> 16,  G = (id >> 8) & 255,  B = id & 255
           id 0 == background (outside brain)

Volume conventions (verified against ccfv3_structures.json):
  axis order (AP, DV, ML), ASL orientation
  origins @10um: bregma_x=540, dv_zero_y=44, midline_z=570
  ap_mm = (540 - x10) * 0.01 ; dv_mm = (y10 - 44) * 0.01 ; ml_mm = (z10 - 570) * 0.01

Usage (from scripts/):
  python export_ccf_id_maps.py \
      --annotation ../react-app/public/atlas/annotation_25.nrrd \
      --res 25 \
      --manifest ../react-app/public/atlas/ccfv3_manifest.json \
      --ontology ../react-app/public/atlas/ccf_ontology.json \
      --out ../react-app/public/atlas
"""

import argparse, json, os, sys
import numpy as np

EXTENT_UM = {"ap": 13200.0, "dv": 8000.0, "ml": 11400.0}


def expected_shape(res_um):
    return (int(round(EXTENT_UM["ap"] / res_um)),
            int(round(EXTENT_UM["dv"] / res_um)),
            int(round(EXTENT_UM["ml"] / res_um)))


def load_volume(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".nrrd":
        try:
            import nrrd
        except ImportError:
            sys.exit("Need pynrrd:  pip install pynrrd")
        data, _ = nrrd.read(path)
        return np.asarray(data)
    try:
        import SimpleITK as sitk
    except ImportError:
        sys.exit("Need SimpleITK for non-nrrd input:  pip install SimpleITK")
    return np.asarray(sitk.GetArrayFromImage(sitk.ReadImage(path)))


def permute_to_ap_dv_ml(vol, res_um):
    want = expected_shape(res_um)
    if vol.shape == want:
        return vol, (0, 1, 2)
    from itertools import permutations
    for p in permutations(range(3)):
        if tuple(vol.shape[i] for i in p) == want:
            return np.transpose(vol, p), p
    sys.exit(f"Cannot match shape {vol.shape} to expected {want} at {res_um}um.")


def flatten_ontology(node, out):
    """Handles Allen structure_graph ({'msg':[...]}) and flat/nested lists."""
    if isinstance(node, dict):
        if "id" in node and ("acronym" in node or "name" in node):
            try:
                out[int(node["id"])] = {
                    "acronym": node.get("acronym"),
                    "name": node.get("name"),
                }
            except (TypeError, ValueError):
                pass
        for key in ("children", "msg", "structures", "data"):
            if key in node:
                flatten_ontology(node[key], out)
    elif isinstance(node, list):
        for n in node:
            flatten_ontology(n, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--annotation", required=True)
    ap.add_argument("--res", type=int, default=25)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--ontology", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        from PIL import Image
    except ImportError:
        sys.exit("Need Pillow:  pip install pillow")

    print(f"Loading {args.annotation} ...")
    vol = load_volume(args.annotation)
    print(f"  raw shape: {vol.shape}")
    vol, perm = permute_to_ap_dv_ml(vol, args.res)
    print(f"  permuted {perm} -> (AP, DV, ML) {vol.shape}  [ACCEPTANCE 1]")

    manifest = json.load(open(args.manifest, "r", encoding="utf-8"))
    slices = manifest if isinstance(manifest, list) else list(manifest.values())
    print(f"  manifest slices: {len(slices)}")

    # ── id -> acronym/name ────────────────────────────────────────────────
    raw = json.load(open(args.ontology, "r", encoding="utf-8"))
    id_map = {}
    flatten_ontology(raw, id_map)
    print(f"  ontology entries: {len(id_map)}")
    if len(id_map) < 100:
        sys.exit("Ontology parse produced too few entries -- check --ontology file.")

    out_dir = os.path.join(args.out, "ccfv3")
    os.makedirs(out_dir, exist_ok=True)

    scale = 10.0 / args.res           # 10um manifest voxel -> volume index
    n_ap, n_dv, n_ml = vol.shape
    written = 0
    ids_seen = set()

    for s in slices:
        vx10 = s.get("voxel_x")
        if vx10 is None:
            continue
        x = int(round(vx10 * scale))
        if not (0 <= x < n_ap):
            continue

        sl = vol[x]                                   # (DV, ML)
        ids_seen.update(np.unique(sl).tolist())

        a = sl.astype(np.uint32)
        rgb = np.zeros((n_dv, n_ml, 3), dtype=np.uint8)
        rgb[..., 0] = (a >> 16) & 0xFF
        rgb[..., 1] = (a >> 8) & 0xFF
        rgb[..., 2] = a & 0xFF

        Image.fromarray(rgb, mode="RGB").save(
            os.path.join(out_dir, f"ids_ap_{vx10}.png"), optimize=True
        )
        written += 1
        if written % 25 == 0:
            print(f"    wrote {written}/{len(slices)}", end="\r")

    print(" " * 60, end="\r")
    print(f"  wrote {written} ID-map PNGs -> {out_dir}/ids_ap_*.png")

    # only ship the IDs actually present, keeps the JSON small
    ids_seen.discard(0)
    trimmed = {str(i): id_map[i] for i in sorted(ids_seen) if i in id_map}
    missing = sorted(i for i in ids_seen if i not in id_map)
    with open(os.path.join(args.out, "id_to_acronym.json"), "w", encoding="utf-8") as f:
        json.dump(trimmed, f, separators=(",", ":"))
    print(f"  id_to_acronym.json: {len(trimmed)} structures"
          f"{f'  ({len(missing)} volume IDs absent from ontology)' if missing else ''}")

    # ── ACCEPTANCE 2/3: known anatomy spot-checks ─────────────────────────
    bregma_x = 5400.0 / args.res
    dv_zero  = 440.0 / args.res
    mid_z    = 5700.0 / args.res

    def probe(ap_mm, ml_mm, dv_mm):
        x = int(round(bregma_x - ap_mm / (args.res / 1000.0)))
        y = int(round(dv_zero + dv_mm / (args.res / 1000.0)))
        z = int(round(mid_z + ml_mm / (args.res / 1000.0)))
        if not (0 <= x < n_ap and 0 <= y < n_dv and 0 <= z < n_ml):
            return "OUT OF BOUNDS"
        sid = int(vol[x, y, z])
        if sid == 0:
            return "background (id 0)"
        e = id_map.get(sid, {})
        return f"{e.get('acronym', '?')} — {e.get('name', 'unknown')} (id {sid})"

    print("\n[ACCEPTANCE 2] dorsal hippocampus  AP -2.05, ML 1.52, DV 1.70")
    print("   expect CA1 (or a CA1 layer):", probe(-2.05, 1.52, 1.70))
    print("[ACCEPTANCE 3] dorsal cortex       AP -2.00, ML 2.00, DV 0.60")
    print("   expect a cortical area  :", probe(-2.00, 2.00, 0.60))
    print("[ACCEPTANCE 4] outside brain       AP -6.30, ML -4.85, DV 0.33")
    print("   expect background       :", probe(-6.30, -4.85, 0.33))


if __name__ == "__main__":
    main()