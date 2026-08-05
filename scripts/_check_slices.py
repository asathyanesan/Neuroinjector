import json, os
from PIL import Image
import numpy as np

base = os.path.join(os.path.dirname(__file__), '..', 'react-app', 'public')
with open(os.path.join(base, 'atlas', 'ccfv3_manifest.json')) as f:
    manifest = json.load(f)

print("total slices:", len(manifest))
for i in range(0, len(manifest), 25):
    entry = manifest[i]
    url = entry['template_url'].lstrip('/')
    path = os.path.join(base, url)
    if not os.path.exists(path):
        print(i, "MISSING", path)
        continue
    im = np.array(Image.open(path).convert('L'))
    h, w = im.shape
    row_has_tissue = (im > 10).any(axis=1)
    nonzero_rows = np.where(row_has_tissue)[0]
    if len(nonzero_rows) == 0:
        top, bottom = None, None
    else:
        top, bottom = int(nonzero_rows[0]), int(nonzero_rows[-1])
    print(f"idx={i} ap={entry.get('ap_mm')} size={w}x{h} top={top} bottom={bottom} touches_bottom={bottom==h-1 if bottom is not None else None}")
