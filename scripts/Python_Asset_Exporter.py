import os
import json
from pathlib import Path
import numpy as np
import SimpleITK as sitk
from PIL import Image

# Import official ABC Atlas Cache manager
from abc_atlas_access.abc_atlas_cache.abc_project_cache import AbcProjectCache

# 1. Initialize Cache Manager (Reads from cached data folder)
download_dir = Path("./data")
cache = AbcProjectCache.from_cache_dir(download_dir)

print("Fetching CCFv3 2020 NIfTI volumes...")
template_path = cache.get_file_path(
    directory="Allen-CCF-2020",
    file_name="average_template_10"
)
boundary_path = cache.get_file_path(
    directory="Allen-CCF-2020",
    file_name="annotation_boundary_10"
)

# 2. Load Volumes into Memory via SimpleITK
template_img = sitk.ReadImage(str(template_path))
boundary_img = sitk.ReadImage(str(boundary_path))

template_arr = sitk.GetArrayViewFromImage(template_img)
boundary_arr = sitk.GetArrayViewFromImage(boundary_img)

# Bregma & Midline Voxel Constants (10 um Resolution)
BREGMA_VOXEL_X = 540  # AP axis voxel index for Bregma
BREGMA_VOXEL_Y = 44   # DV axis voxel index for Skull Surface
MIDLINE_VOXEL_Z = 570 # ML center line

output_dir = os.path.abspath("../react-app/public/atlas/ccfv3")
os.makedirs(output_dir, exist_ok=True)

manifest = []

# 3. OPTION B: Export High-Precision Slices (50 um / 0.05 mm step size)
# Range 100 to 1250 with step 5 -> 230 slices covering +4.40 mm to -7.10 mm AP
for x_idx in range(100, 1250, 5):
    ap_mm = round((BREGMA_VOXEL_X - x_idx) * 0.01, 2)
    
    template_slice = np.transpose(template_arr[:, :, x_idx])
    boundary_slice = np.transpose(boundary_arr[:, :, x_idx])
    
    # Save Template PNG
    norm_template = ((template_slice - template_slice.min()) / 
                     (template_slice.max() - template_slice.min() + 1e-5) * 255).astype(np.uint8)
    img_tpl = Image.fromarray(norm_template)
    tpl_filename = f"tpl_ap_{x_idx}.png"
    img_tpl.save(os.path.join(output_dir, tpl_filename))
    
    # Save Boundary PNG
    norm_boundary = (boundary_slice > 0).astype(np.uint8) * 255
    img_bnd = Image.fromarray(norm_boundary)
    bnd_filename = f"bnd_ap_{x_idx}.png"
    img_bnd.save(os.path.join(output_dir, bnd_filename))
    
    manifest.append({
        "voxel_x": x_idx,
        "ap_mm": ap_mm,
        "template_url": f"/atlas/ccfv3/{tpl_filename}",
        "boundary_url": f"/atlas/ccfv3/{bnd_filename}"
    })

# Save JSON Manifest for Frontend
manifest_path = os.path.join(output_dir, "..", "ccfv3_manifest.json")
with open(manifest_path, "w") as f:
    json.dump(manifest, f, indent=2)

print(f"Done! {len(manifest)} high-precision coronal slices exported to: {output_dir}")