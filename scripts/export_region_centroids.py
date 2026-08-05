import os
import json
from pathlib import Path
import numpy as np
import SimpleITK as sitk
from scipy.ndimage import center_of_mass

# Import official ABC Atlas Cache manager
from abc_atlas_access.abc_atlas_cache.abc_project_cache import AbcProjectCache

# 1. Initialize Cache Manager
download_dir = Path("./data")
cache = AbcProjectCache.from_cache_dir(download_dir)

print("Fetching metadata and annotation_10 volume...")
annotation_path = cache.get_file_path(
    directory="Allen-CCF-2020",
    file_name="annotation_10"
)

# Fetch structure metadata directly via abc_atlas_access (no external HTTP calls!)
membership_df = cache.get_metadata_dataframe(
    directory="Allen-CCF-2020",
    file_name="parcellation_to_parcellation_term_membership"
)

# Build a lookup table mapping each voxel ID to structure acronym, name & color
structure_map = {}
for _, row in membership_df.iterrows():
    p_idx = int(row["parcellation_index"])
    # Prefer structure-level terms when available
    if p_idx not in structure_map or row.get("parcellation_term_set_name") == "structure":
        hex_color = str(row.get("color_hex_triplet", "#10b981"))
        if not hex_color.startswith("#"):
            hex_color = f"#{hex_color}"
            
        structure_map[p_idx] = {
            "acronym": str(row.get("parcellation_term_acronym", f"ID_{p_idx}")),
            "name": str(row.get("parcellation_term_name", f"Structure {p_idx}")),
            "color_hex": hex_color
        }

print("Loading 3D annotation volume into memory...")
anno_img = sitk.ReadImage(str(annotation_path))
anno_arr = sitk.GetArrayViewFromImage(anno_img) # Shape layout: [z (ML), y (DV), x (AP)]

unique_ids = np.unique(anno_arr)
unique_ids = unique_ids[unique_ids > 0] # Exclude background (0)

print(f"Calculating 3D centroids for {len(unique_ids)} brain regions...")
# Calculate exact center of mass (z, y, x) for every region ID in 3D
centroids = center_of_mass(np.ones_like(anno_arr), labels=anno_arr, index=unique_ids)

# CCFv3 Stereotaxic Reference Constants (10 um Resolution)
BREGMA_VOXEL_X = 540  # AP Axis
BREGMA_VOXEL_Y = 44   # DV Axis
MIDLINE_VOXEL_Z = 570 # ML Axis

structures_manifest = []

for struct_id, (z, y, x) in zip(unique_ids, centroids):
    struct_id = int(struct_id)
    info = structure_map.get(struct_id, {
        "acronym": f"ID_{struct_id}",
        "name": f"Region {struct_id}",
        "color_hex": "#10b981"
    })
    
    # Calculate Stereotaxic Coordinates in mm relative to Bregma
    ap_mm = round((BREGMA_VOXEL_X - float(x)) * 0.01, 2)
    dv_mm = round((float(y) - BREGMA_VOXEL_Y) * 0.01, 2)
    ml_mm = round((float(z) - MIDLINE_VOXEL_Z) * 0.01, 2)
    
    structures_manifest.append({
        "id": struct_id,
        "acronym": info["acronym"],
        "name": info["name"],
        "color_hex": info["color_hex"],
        "voxel_x": round(float(x), 1),
        "voxel_y": round(float(y), 1),
        "voxel_z": round(float(z), 1),
        "ap_mm": ap_mm,
        "dv_mm": dv_mm,
        "ml_mm": ml_mm
    })

# Sort alphabetically by acronym
structures_manifest.sort(key=lambda item: item["acronym"].lower())

output_path = os.path.abspath("../react-app/public/atlas/ccfv3_structures.json")
with open(output_path, "w") as f:
    json.dump(structures_manifest, f, indent=2)

print(f"Done! {len(structures_manifest)} structure centroids saved to: {output_path}")