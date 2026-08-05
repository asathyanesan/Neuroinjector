import React, { useState, useEffect, useRef } from 'react';

const CCF_VOXEL_SIZE_MM = 0.01;
const BREGMA_DV_VOXEL = 44;
const MIDLINE_ML_VOXEL = 570;

// Manifest/structure JSON store root-absolute URLs (e.g. "/atlas/ccfv3/tpl_ap_100.png");
// rewrite them relative to the app's base path so it works under a subpath deployment.
function resolveAssetUrl(url) {
  if (!url) return url;
  return url.replace(/^\//, import.meta.env.BASE_URL);
}

// ─────────────────────────────────────────────────────────────
// §4k  Centroid-based nearest-structure lookup.
// Uses the SAME coordinate convention as handleSvgClick:
//   ml_mm = (voxel_z - 570) * 0.01   (signed; + = right)
//   dv_mm = (voxel_y - 44)  * 0.01   (POSITIVE-DOWN; + = ventral)
// The ccfv3_structures.json centroids are already stored in this
// convention (verified: voxel_z 569.5 → ml_mm -0.01, voxel_y 653.1
// → dv_mm 6.09), so no sign flip is needed.
// ─────────────────────────────────────────────────────────────
function findNearestStructure(ap_mm, ml_mm, dv_mm, structs) {
  if (!structs || structs.length === 0) return null;
  const AP_WINDOW = 1.5; // mm — only consider structures near this coronal plane

  let best = null;
  let bestDist = Infinity;

  for (const s of structs) {
    if (s.ap_mm == null || s.ml_mm == null || s.dv_mm == null) continue;
    if (Math.abs(s.ap_mm - ap_mm) > AP_WINDOW) continue;

    const d = Math.hypot(s.ml_mm - ml_mm, s.dv_mm - dv_mm);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }

  return best
    ? { acronym: best.acronym, name: best.name, dist: bestDist }
    : null;
}

export default function AllenAtlasViewer({ onTargetSelect }) {
  const [slices, setSlices] = useState([]);
  const [structures, setStructures] = useState([]);
  const [sliceIndex, setSliceIndex] = useState(0);
  const [selectedSearch, setSelectedSearch] = useState('');
  const [selectedRegionInfo, setSelectedRegionInfo] = useState(null);
  const [showBoundaries, setShowBoundaries] = useState(true);
  const [showGrid, setShowGrid] = useState(false); // §4j
  const [clickedTarget, setClickedTarget] = useState(null);
  const [zoom, setZoom] = useState(1);
  const svgRef = useRef(null);

  // §4i — local draft strings so the user can type "-2." without the
  // controlled value reverting mid-keystroke. Committed on blur / Enter.
  const [draftAp, setDraftAp] = useState('');
  const [draftMl, setDraftMl] = useState('');
  const [draftDv, setDraftDv] = useState('');

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}atlas/ccfv3_manifest.json`)
      .then((res) => res.json())
      .then((data) => setSlices(data))
      .catch((err) => console.error('Error loading slices:', err));

    fetch(`${import.meta.env.BASE_URL}atlas/ccfv3_structures.json`)
      .then((res) => res.json())
      .then((data) => setStructures(data))
      .catch((err) => console.error('Error loading structures:', err));
  }, []);

  const activeSlice = slices[sliceIndex] || { ap_mm: 0, template_url: '', boundary_url: '' };

  // §4i — keep draft inputs in sync whenever the target changes
  // (via click, search, or a committed manual edit).
  useEffect(() => {
    if (clickedTarget) {
      setDraftAp(clickedTarget.ap != null ? String(clickedTarget.ap) : '');
      setDraftMl(clickedTarget.ml != null ? String(clickedTarget.ml) : '');
      setDraftDv(clickedTarget.dv != null ? String(clickedTarget.dv) : '');
    } else {
      setDraftAp('');
      setDraftMl('');
      setDraftDv('');
    }
  }, [clickedTarget]);

  const handleRegionSelect = (e) => {
    const val = e.target.value;
    setSelectedSearch(val);

    const match = structures.find(
      (s) => `${s.acronym} - ${s.name}`.toLowerCase() === val.toLowerCase() || s.acronym.toLowerCase() === val.toLowerCase()
    );

    if (match && slices.length > 0) {
      setSelectedRegionInfo(match);

      let closestIdx = 0;
      let minDiff = Infinity;
      slices.forEach((s, idx) => {
        const diff = Math.abs(s.voxel_x - match.voxel_x);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = idx;
        }
      });

      setSliceIndex(closestIdx);

      const xRatio = match.voxel_z / 1140;
      const yRatio = match.voxel_y / 800;

      const targetData = {
        xRatio,
        yRatio,
        voxelZ: match.voxel_z,
        voxelY: match.voxel_y,
        ap: match.ap_mm,
        ml: match.ml_mm,
        dv: match.dv_mm,
        region: match.acronym,
        name: match.name
      };

      setClickedTarget(targetData);
      if (onTargetSelect) onTargetSelect(targetData);
    }
  };

  const handleSvgClick = (e) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;

    const voxelZ = Math.round(xRatio * 1140);
    const voxelY = Math.round(yRatio * 800);

    const ml_mm = parseFloat(((voxelZ - MIDLINE_ML_VOXEL) * CCF_VOXEL_SIZE_MM).toFixed(2));
    const dv_mm = parseFloat(((voxelY - BREGMA_DV_VOXEL) * CCF_VOXEL_SIZE_MM).toFixed(2));

    // §4k — identify the nearest CCF structure instead of "Custom Click"
    const nearest = findNearestStructure(activeSlice.ap_mm, ml_mm, dv_mm, structures);

    const targetData = {
      xRatio,
      yRatio,
      voxelZ,
      voxelY,
      ap: activeSlice.ap_mm,
      ml: ml_mm,
      dv: dv_mm,
      region: nearest ? nearest.acronym : 'Custom Click',
      name: nearest ? nearest.name : ''
    };

    // A manual click no longer corresponds to the previously searched structure,
    // so clear it rather than leave a mismatched reference card on screen.
    setSelectedRegionInfo(null);
    setSelectedSearch('');
    setClickedTarget(targetData);
    if (onTargetSelect) onTargetSelect(targetData);
  };

  const handleApInput = (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isNaN(val) || slices.length === 0) return;

    let closestIdx = 0;
    let minDiff = Infinity;
    slices.forEach((s, idx) => {
      const diff = Math.abs(s.ap_mm - val);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });
    setSliceIndex(closestIdx);
  };

  // §4i — recompute the whole target (crosshair + region) from a
  // partial coordinate change, then broadcast it to the parent.
  const applyManualCoord = (partial) => {
    const base = clickedTarget || {
      ap: activeSlice.ap_mm,
      ml: 0,
      dv: 0,
      voxelZ: MIDLINE_ML_VOXEL,
      voxelY: BREGMA_DV_VOXEL,
      xRatio: MIDLINE_ML_VOXEL / 1140,
      yRatio: BREGMA_DV_VOXEL / 800
    };

    const next = { ...base, ...partial };

    // Round for clean display
    next.ap = parseFloat(Number(next.ap).toFixed(2));
    next.ml = parseFloat(Number(next.ml).toFixed(2));
    next.dv = parseFloat(Number(next.dv).toFixed(2));

    // Recompute crosshair position from ML / DV (positive-down convention)
    next.voxelZ = next.ml / CCF_VOXEL_SIZE_MM + MIDLINE_ML_VOXEL;
    next.voxelY = next.dv / CCF_VOXEL_SIZE_MM + BREGMA_DV_VOXEL;
    next.xRatio = next.voxelZ / 1140;
    next.yRatio = next.voxelY / 800;

    // Re-identify region from the typed coordinates (§4k)
    const nearest = findNearestStructure(next.ap, next.ml, next.dv, structures);
    next.region = nearest ? nearest.acronym : 'Custom Click';
    next.name = nearest ? nearest.name : '';

    setSelectedRegionInfo(null);
    setSelectedSearch('');
    setClickedTarget(next);
    if (onTargetSelect) onTargetSelect(next);
  };

  const commitAp = () => {
    const v = parseFloat(draftAp);
    if (Number.isNaN(v) || slices.length === 0) return;
    // Snap to nearest slice and use that slice's true AP
    let closestIdx = 0;
    let minDiff = Infinity;
    slices.forEach((s, idx) => {
      const diff = Math.abs(s.ap_mm - v);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });
    setSliceIndex(closestIdx);
    const snappedAp = slices[closestIdx] ? slices[closestIdx].ap_mm : v;
    applyManualCoord({ ap: snappedAp });
  };

  const commitMl = () => {
    const v = parseFloat(draftMl);
    if (!Number.isNaN(v)) applyManualCoord({ ml: v });
  };

  const commitDv = () => {
    const v = parseFloat(draftDv);
    if (!Number.isNaN(v)) applyManualCoord({ dv: v });
  };

  const onKeyCommit = (fn) => (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      fn();
    }
  };

  const zoomIn = () => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)));
  const zoomReset = () => setZoom(1);

  const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);

  return (
    <div style={styles.sidebarContainer}>
      <h3 style={styles.heading}>CCFv3 Atlas Search</h3>

      <div style={styles.searchSection}>
        <input
          list="structures-list"
          type="text"
          placeholder="Search region (CA1, BLA, CP)..."
          value={selectedSearch}
          onChange={handleRegionSelect}
          style={styles.searchInput}
        />
        <datalist id="structures-list">
          {structures.map((s) => (
            <option key={s.id} value={`${s.acronym} - ${s.name}`} />
          ))}
        </datalist>
      </div>

      <div style={styles.zoomControls}>
        <button type="button" onClick={zoomOut} style={styles.zoomBtn} aria-label="Zoom out">−</button>
        <span style={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={zoomIn} style={styles.zoomBtn} aria-label="Zoom in">+</button>
        <button type="button" onClick={zoomReset} style={styles.zoomBtn}>Reset</button>
      </div>

      {/* §4j — layer toggles */}
      <div style={styles.toggleRow}>
        <label style={styles.toggle}>
          <input
            type="checkbox"
            checked={showBoundaries}
            onChange={(e) => setShowBoundaries(e.target.checked)}
          />
          Boundaries
        </label>
        <label style={styles.toggle}>
          <input
            type="checkbox"
            checked={showGrid}
            onChange={(e) => setShowGrid(e.target.checked)}
          />
          1&nbsp;mm grid
        </label>
      </div>

      <div style={styles.canvasContainer}>
        <div style={styles.svgWrapper} onClick={handleSvgClick}>
          <svg ref={svgRef} viewBox="0 0 1140 800" style={{ ...styles.svg, transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
            {activeSlice.template_url && (
              <image href={resolveAssetUrl(activeSlice.template_url)} x="0" y="0" width="1140" height="800" preserveAspectRatio="none" />
            )}
            {showBoundaries && activeSlice.boundary_url && (
              <image href={resolveAssetUrl(activeSlice.boundary_url)} x="0" y="0" width="1140" height="800" preserveAspectRatio="none" style={{ opacity: 0.45, mixBlendMode: 'screen' }} />
            )}

            {/* §4j — 1 mm Paxinos-style gridlines (1 mm = 100 SVG units) */}
            {showGrid && (
              <g pointerEvents="none">
                {/* Vertical ML lines, ±6 mm around midline voxel 570 */}
                {Array.from({ length: 13 }, (_, i) => i - 6).map((n) =>
                  n !== 0 ? (
                    <line
                      key={`ml${n}`}
                      x1={570 + n * 100} y1={0}
                      x2={570 + n * 100} y2={800}
                      stroke="#334155" strokeWidth="1" strokeDasharray="3 5"
                    />
                  ) : null
                )}
                {/* Horizontal DV lines, 1–8 mm below bregma-surface voxel 44 */}
                {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                  <line
                    key={`dv${n}`}
                    x1={0} y1={44 + n * 100}
                    x2={1140} y2={44 + n * 100}
                    stroke="#334155" strokeWidth="1" strokeDasharray="3 5"
                  />
                ))}
                {/* ML labels along the top edge */}
                {Array.from({ length: 13 }, (_, i) => i - 6).map((n) =>
                  n !== 0 ? (
                    <text
                      key={`mll${n}`}
                      x={570 + n * 100} y={14}
                      fill="#64748b" fontSize="13" textAnchor="middle"
                    >
                      {n > 0 ? `+${n}` : n}
                    </text>
                  ) : null
                )}
                {/* DV labels along the left edge */}
                {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                  <text
                    key={`dvl${n}`}
                    x={5} y={44 + n * 100 - 5}
                    fill="#64748b" fontSize="13"
                  >
                    -{n}
                  </text>
                ))}
              </g>
            )}

            <line x1="570" y1="0" x2="570" y2="800" stroke="#ef4444" strokeDasharray="6 6" strokeWidth="2" />
            <line x1="0" y1="44" x2="1140" y2="44" stroke="#3b82f6" strokeDasharray="4 4" strokeWidth="2" />

            {clickedTarget && (
              <g transform={`translate(${clickedTarget.xRatio * 1140}, ${clickedTarget.yRatio * 800})`}>
                <circle r="16" fill="none" stroke="#f59e0b" strokeWidth="3" />
                <line x1="-22" y1="0" x2="22" y2="0" stroke="#f59e0b" strokeWidth="2" />
                <line x1="0" y1="-22" x2="0" y2="22" stroke="#f59e0b" strokeWidth="2" />
                <circle r="5" fill="#ef4444" />
              </g>
            )}
          </svg>
        </div>
      </div>

      <div style={styles.sliderSection}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem' }}>
          <span>AP Position:</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="number"
              step="0.05"
              value={activeSlice.ap_mm}
              onChange={handleApInput}
              style={styles.apInput}
            />
            <span>mm</span>
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={slices.length > 0 ? slices.length - 1 : 0}
          value={sliceIndex}
          onChange={(e) => setSliceIndex(Number(e.target.value))}
          style={{ width: '100%', marginTop: '6px' }}
        />
      </div>

      {selectedRegionInfo && (
        <div style={styles.card}>
          <h4 style={{ color: selectedRegionInfo.color_hex, margin: 0 }}>
            {selectedRegionInfo.acronym}
          </h4>
          <p style={{ margin: '2px 0 8px 0', fontSize: '0.8rem', color: '#94a3b8' }}>
            {selectedRegionInfo.name}
          </p>
          <div style={styles.coordGrid}>
            <div><span>AP:</span> <strong>{fmt(selectedRegionInfo.ap_mm)}</strong></div>
            <div><span>ML:</span> <strong>{fmt(selectedRegionInfo.ml_mm)}</strong></div>
            <div><span>DV:</span> <strong>{selectedRegionInfo.dv_mm}</strong></div>
          </div>
        </div>
      )}

      <div style={styles.targetCard}>
        <h5 style={{ margin: '0 0 6px 0', color: '#f59e0b' }}>Active Target Coordinates</h5>

        {/* §4k — identified structure badge */}
        {clickedTarget && clickedTarget.region && clickedTarget.region !== 'Custom Click' && (
          <div style={styles.regionBadge}>
            CCF: {clickedTarget.region}
            {clickedTarget.name ? <span style={styles.regionBadgeSub}> — {clickedTarget.name}</span> : null}
          </div>
        )}

        {/* §4i — manual coordinate entry (AP / ML / DV all typable) */}
        <div style={styles.manualEntry}>
          <span style={styles.coordLabel}>AP</span>
          <input
            type="number"
            step="0.05"
            value={draftAp}
            placeholder="—"
            onChange={(e) => setDraftAp(e.target.value)}
            onBlur={commitAp}
            onKeyDown={onKeyCommit(commitAp)}
            style={styles.manualInput}
          />
          <span style={styles.coordUnit}>mm</span>

          <span style={styles.coordLabel}>ML</span>
          <input
            type="number"
            step="0.05"
            value={draftMl}
            placeholder="—"
            onChange={(e) => setDraftMl(e.target.value)}
            onBlur={commitMl}
            onKeyDown={onKeyCommit(commitMl)}
            style={styles.manualInput}
          />
          <span style={styles.coordUnit}>mm</span>

          <span style={styles.coordLabel}>DV</span>
          <input
            type="number"
            step="0.05"
            value={draftDv}
            placeholder="—"
            onChange={(e) => setDraftDv(e.target.value)}
            onBlur={commitDv}
            onKeyDown={onKeyCommit(commitDv)}
            style={styles.manualInput}
          />
          <span style={styles.coordUnit}>mm</span>
        </div>

        {!clickedTarget && (
          <p style={{ color: '#64748b', fontSize: '0.78rem', margin: '8px 0 0 0' }}>
            Type coordinates above, or click/search a slice. DV is positive-down (ventral).
          </p>
        )}
      </div>
    </div>
  );
}

const styles = {
  sidebarContainer: { display: 'flex', flexDirection: 'column', gap: 12, padding: 14, color: '#f8fafc' },
  heading: { margin: '0 0 4px 0', fontSize: '1.05rem' },
  searchSection: { width: '100%' },
  searchInput: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #475569', backgroundColor: '#0f172a', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' },
  canvasContainer: { backgroundColor: '#000', borderRadius: 6, overflow: 'auto', border: '1px solid #334155', maxHeight: '65vh' },
  svgWrapper: { width: '100%', cursor: 'crosshair' },
  svg: { width: '100%', height: 'auto', display: 'block' },
  zoomControls: { display: 'flex', alignItems: 'center', gap: 8 },
  zoomBtn: { backgroundColor: '#1e293b', border: '1px solid #475569', color: '#f8fafc', borderRadius: 6, padding: '4px 10px', fontSize: '0.85rem', cursor: 'pointer' },
  zoomLabel: { fontSize: '0.8rem', minWidth: 40, textAlign: 'center', color: '#94a3b8' },
  toggleRow: { display: 'flex', gap: 16, alignItems: 'center', fontSize: '0.8rem', color: '#94a3b8' },
  toggle: { display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' },
  apInput: { width: 70, padding: '4px 6px', borderRadius: 4, border: '1px solid #475569', backgroundColor: '#1e293b', color: '#fff', fontSize: '0.85rem' },
  sliderSection: { backgroundColor: '#0f172a', padding: 10, borderRadius: 6, border: '1px solid #334155' },
  card: { backgroundColor: '#0284c715', border: '1px solid #0284c7', padding: 10, borderRadius: 6 },
  targetCard: { backgroundColor: '#0f172a', border: '1px solid #f59e0b', padding: 10, borderRadius: 6 },
  coordGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, fontSize: '0.82rem' },
  regionBadge: { fontSize: '0.82rem', color: '#38bdf8', fontWeight: 600, marginBottom: 8 },
  regionBadgeSub: { color: '#94a3b8', fontStyle: 'italic', fontWeight: 400 },
  manualEntry: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '6px 8px', alignItems: 'center' },
  manualInput: { width: '100%', padding: '4px 6px', borderRadius: 4, border: '1px solid #475569', backgroundColor: '#1e293b', color: '#fff', fontSize: '0.82rem', boxSizing: 'border-box' },
  coordLabel: { color: '#f59e0b', fontWeight: 600, fontSize: '0.82rem' },
  coordUnit: { color: '#64748b', fontSize: '0.75rem' }
};
