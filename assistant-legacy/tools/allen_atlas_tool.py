import os
import json
from typing import Dict, Any, Optional
from allensdk.core.mouse_connectivity_cache import MouseConnectivityCache

class AllenAtlasTool:
    """
    Token-efficient Allen CCFv3 Coordinate & Structure Lookup Tool.
    Converts CCFv3 coordinates (in um) to stereotaxic coordinates (in mm from Bregma).
    """

    # Estimated Bregma point in Allen CCFv3 space (10 um voxel resolution)
    # [AP, DV, ML] in um
    CCF_BREGMA = {
        "AP": 5400,  # 5.40 mm from anterior origin
        "DV": 440,   # 0.44 mm from superior origin (dura surface level)
        "ML": 5700   # 5.70 mm from lateral origin (midline)
    }

    def __init__(self, manifest_file: str = "brain_data/manifest.json"):
        # Initialize Allen SDK Cache (downloads light structure tree metadata only)
        self.mcc = MouseConnectivityCache(manifest_file=manifest_file, resolution=10)
        self.structure_tree = self.mcc.get_structure_tree()

    def get_structure_info(self, query: str) -> Dict[str, Any]:
        """Looks up structure by exact acronym or fuzzy name search."""
        query = query.strip()
        
        # 1. Try search by acronym (e.g., 'VTA', 'BLA', 'CPu', 'CA1')
        structures = self.structure_tree.get_structures_by_acronym([query])
        
        # 2. Fallback to name search (e.g., 'Ventral tegmental area')
        if not structures:
            structures = self.structure_tree.get_structures_by_name([query])

        if not structures:
            return {"error": f"Structure '{query}' not found in Allen CCF ontology."}

        struct = structures[0]
        return {
            "id": struct["id"],
            "acronym": struct["acronym"],
            "name": struct["name"],
            "structure_id_path": struct["structure_id_path"]
        }

    def ccf_to_bregma(self, ccf_ap_um: float, ccf_dv_um: float, ccf_ml_um: float) -> Dict[str, float]:
        """
        Transforms Allen CCFv3 voxel coordinates (um) to standard Stereotaxic coordinates (mm from Bregma).
        
        Coordinate Conventions:
        - AP: Positive = Anterior, Negative = Posterior
        - ML: Distance from midline (+/-)
        - DV: Positive = Ventral (depth from dura)
        """
        ap_mm = (self.CCF_BREGMA["AP"] - ccf_ap_um) / 1000.0
        dv_mm = (ccf_dv_um - self.CCF_BREGMA["DV"]) / 1000.0
        ml_mm = (ccf_ml_um - self.CCF_BREGMA["ML"]) / 1000.0

        return {
            "AP_mm": round(ap_mm, 2),
            "DV_mm": round(dv_mm, 2),
            "ML_mm": round(ml_mm, 2)
        }

    def get_target_coordinates(self, structure_query: str, ccf_coords: Optional[list] = None) -> str:
        """
        Main tool function called by the Agent. Returns minimal JSON payload.
        """
        info = self.get_structure_info(structure_query)
        if "error" in info:
            return json.dumps(info)

        response = {
            "structure_name": info["name"],
            "acronym": info["acronym"],
            "structure_id": info["id"]
        }

        # If raw CCF coordinates were provided or fetched
        if ccf_coords and len(ccf_coords) == 3:
            bregma_coords = self.ccf_to_bregma(ccf_coords[0], ccf_coords[1], ccf_coords[2])
            response["estimated_bregma_mm"] = bregma_coords

        return json.dumps(response)


# Direct Standalone Test
if __name__ == "__main__":
    tool = AllenAtlasTool()
    
    # Test lookup for Basolateral Amygdala (BLA) at example CCF point [7100, 3500, 2800]
    result = tool.get_target_coordinates("BLA", ccf_coords=[7100, 3500, 2800])
    print("Clean Payload Output for Agent:\n", result)