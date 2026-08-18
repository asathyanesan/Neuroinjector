import React, { useState, useEffect, useRef, useCallback } from 'react';

const CCF_VOXEL_SIZE_MM = 0.01;
const BREGMA_DV_VOXEL = 44;
const MIDLINE_ML_VOXEL = 570;

// Full CCF coronal extent at 10 um, in viewBox units (1 unit == 1 voxel).
const VOL_W = 1140; // ML
const VOL_H = 800;  // DV

function resolveAssetUrl(url) {
  if (!url) return url;
  return url.replace(/^\//, import.meta.env.BASE_URL);
}

// ─────────────────────────────────────────────────────────────
// Region identification comes from the CCF annotation volume via
// per-slice structure-ID maps (ids_ap_*.png, ID packed into RGB),
// NOT from centroids.
//
// The old centroid approach was structurally unfixable:
// ccfv3_structures.json stores one midline point per structure per
// AP level -- ml_mm ~= -0.01 for all 687 entries, with no extent or
// bbox. So a point->structure query had no lateral information at
// all, and DV centroids are averaged over the whole coronal slice.
// Concrete failure: SSp-un's centroid sits at DV ~1.7 because
// lateral cortex curves ventrally, so it beat CA1 for a click at
// (ML 1.52, DV 1.70) that is plainly hippocampus.
//
// Verified against annotation_25.nrrd: that same coordinate now
// resolves to DG-mo (dentate gyrus, molecular layer). id 0 is
// background, so the ID map also serves as the tissue mask.
// ─────────────────────────────────────────────────────────────

export default function AllenAtlasViewer({ onTargetSelect }) {
  const [slices, setSlices] = useState([]);
  const [structures, setStructures] = useState([]);
  const [idToAcronym, setIdToAcronym] = useState(null);
  const [sliceIndex, setSliceIndex] = useState(0);
  const [selectedSearch, setSelectedSearch] = useState('');
  const [selectedRegionInfo, setSelectedRegionInfo] = useState(null);
  const [showBoundaries, setShowBoundaries] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [clickedTarget, setClickedTarget] = useState(null);
  const [zoom, setZoom] = useState(1);
  const svgRef = useRef(null);

  // Offscreen canvas holding the current slice's structure-ID map.
  const idMapRef = useRef({ ctx: null, w: 0, h: 0, ready: false });

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

    fetch(`${import.meta.env.BASE_URL}atlas/id_to_acronym.json`)
      .then((res) => res.json())
      .then((data) => setIdToAcronym(data))
      .catch(() => console.warn('id_to_acronym.json not found — region names unavailable'));
  }, []);

  const activeSlice = slices[sliceIndex] || { ap_mm: 0, template_url: '', boundary_url: '' };

  // ── Rasterise the per-slice structure-ID map offscreen ──
  // URL derived from the template: tpl_ap_100.png -> ids_ap_100.png
  useEffect(() => {
    if (!activeSlice.template_url) { idMapRef.current.ready = false; return; }
    const idUrl = resolveAssetUrl(activeSlice.template_url).replace('tpl_ap_', 'ids_ap_');
    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (cancelled) return;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      idMapRef.current = { ctx, w: c.width, h: c.height, ready: true };
    };
    img.onerror = () => {
      idMapRef.current.ready = false;
      console.warn('Structure-ID map missing for this slice:', idUrl);
    };
    img.src = idUrl;
    return () => { cancelled = true; };
  }, [activeSlice.template_url]);

  // voxel (z, y) -> exact CCF structure.
  //   null            = background (outside brain)
  //   {unavailable}   = ID map not loaded for this slice
  const lookupStructure = useCallback((voxelZ, voxelY) => {
    const m = idMapRef.current;
    if (!m.ready || !m.ctx) return { unavailable: true };
    const px = Math.round((voxelZ / VOL_W) * m.w);
    const py = Math.round((voxelY / VOL_H) * m.h);
    if (px < 0 || py < 0 || px >= m.w || py >= m.h) return null;
    let d;
    try {
      d = m.ctx.getImageData(px, py, 1, 1).data;
    } catch {
      return { unavailable: true };
    }
    const id = (d[0] << 16) | (d[1] << 8) | d[2];
    if (id === 0) return null; // background
    const e = idToAcronym ? idToAcronym[String(id)] : null;
    return { id, acronym: e ? e.acronym : `id:${id}`, name: e ? e.name : '' };
  }, [idToAcronym]);

  useEffect(() => {
    if (clickedTarget) {
      setDraftAp(clickedTarget.ap != null ? String(clickedTarget.ap) : '');
      setDraftMl(clickedTarget.ml != null ? String(clickedTarget.ml) : '');
      setDraftDv(clickedTarget.dv != null ? String(clickedTarget.dv) : '');
    } else {
      setDraftAp(''); setDraftMl(''); setDraftDv('');
    }
  }, [clickedTarget]);

  // ── Zoom as a viewBox window, NOT a CSS transform ──
  // A CSS scale() desyncs screen px from viewBox units and breaks
  // getScreenCTM-based click mapping. Shrinking the viewBox keeps
  // 1 viewBox unit == 1 voxel at every zoom level.
  const viewW = VOL_W / zoom;
  const viewH = VOL_H / zoom;
  const rawCx = clickedTarget && clickedTarget.voxelZ != null ? clickedTarget.voxelZ : VOL_W / 2;
  const rawCy = clickedTarget && clickedTarget.voxelY != null ? clickedTarget.voxelY : VOL_H / 2;
  const cx = Math.min(Math.max(rawCx, viewW / 2), VOL_W - viewW / 2);
  const cy = Math.min(Math.max(rawCy, viewH / 2), VOL_H - viewH / 2);
  const viewBox = `${cx - viewW / 2} ${cy - viewH / 2} ${viewW} ${viewH}`;

  const handleRegionSelect = (e) => {
    const val = e.target.value;
    setSelectedSearch(val);

    const match = structures.find(
      (s) => `${s.acronym} - ${s.name}`.toLowerCase() === val.toLowerCase()
          || s.acronym.toLowerCase() === val.toLowerCase()
    );

    if (match && slices.length > 0) {
      setSelectedRegionInfo(match);

      let closestIdx = 0, minDiff = Infinity;
      slices.forEach((s, idx) => {
        const diff = Math.abs(s.voxel_x - match.voxel_x);
        if (diff < minDiff) { minDiff = diff; closestIdx = idx; }
      });
      setSliceIndex(closestIdx);

      const targetData = {
        xRatio: match.voxel_z / VOL_W,
        yRatio: match.voxel_y / VOL_H,
        voxelZ: match.voxel_z,
        voxelY: match.voxel_y,
        ap: match.ap_mm,
        ml: match.ml_mm,
        dv: match.dv_mm,
        region: match.acronym,
        name: match.name,
        structureId: match.id ?? null,
        outsideTissue: false
      };

      setClickedTarget(targetData);
      if (onTargetSelect) onTargetSelect(targetData);
    }
  };

  // ── Screen px -> viewBox units via getScreenCTM().inverse() ──
  // The old getBoundingClientRect() ratio math divided by the FULL
  // scaled SVG height while the container clipped with overflow:auto,
  // so yRatio came out far too small -> DV far too dorsal.
  const handleSvgClick = (e) => {
    const svg = svgRef.current;
    if (!svg || typeof svg.getScreenCTM !== 'function') return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;

    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const loc = pt.matrixTransform(ctm.inverse());

    if (loc.x < 0 || loc.x > VOL_W || loc.y < 0 || loc.y > VOL_H) return;

    const voxelZ = loc.x;
    const voxelY = loc.y;

    const ml_mm = parseFloat(((voxelZ - MIDLINE_ML_VOXEL) * CCF_VOXEL_SIZE_MM).toFixed(2));
    const dv_mm = parseFloat(((voxelY - BREGMA_DV_VOXEL) * CCF_VOXEL_SIZE_MM).toFixed(2));

    const hit = lookupStructure(voxelZ, voxelY);
    const outside = hit === null;
    const unavailable = !!(hit && hit.unavailable);

    const targetData = {
      xRatio: voxelZ / VOL_W,
      yRatio: voxelY / VOL_H,
      voxelZ,
      voxelY,
      ap: activeSlice.ap_mm,
      ml: ml_mm,
      dv: dv_mm,
      region: outside ? 'Outside brain'
            : unavailable ? 'ID map unavailable'
            : hit.acronym,
      name: (!outside && !unavailable) ? hit.name : '',
      structureId: (!outside && !unavailable) ? hit.id : null,
      outsideTissue: outside,
      idMapUnavailable: unavailable
    };

    setSelectedRegionInfo(null);
    setSelectedSearch('');
    setClickedTarget(targetData);
    if (onTargetSelect) onTargetSelect(targetData);
  };

  const handleApInput = (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isNaN(val) || slices.length === 0) return;
    let closestIdx = 0, minDiff = Infinity;
    slices.forEach((s, idx) => {
      const diff = Math.abs(s.ap_mm - val);
      if (diff < minDiff) { minDiff = diff; closestIdx = idx; }
    });
    setSliceIndex(closestIdx);
  };

  const applyManualCoord = (partial) => {
    const base = clickedTarget || {
      ap: activeSlice.ap_mm, ml: 0, dv: 0,
      voxelZ: MIDLINE_ML_VOXEL, voxelY: BREGMA_DV_VOXEL,
      xRatio: MIDLINE_ML_VOXEL / VOL_W, yRatio: BREGMA_DV_VOXEL / VOL_H
    };
    const next = { ...base, ...partial };

    next.ap = parseFloat(Number(next.ap).toFixed(2));
    next.ml = parseFloat(Number(next.ml).toFixed(2));
    next.dv = parseFloat(Number(next.dv).toFixed(2));

    next.voxelZ = next.ml / CCF_VOXEL_SIZE_MM + MIDLINE_ML_VOXEL;
    next.voxelY = next.dv / CCF_VOXEL_SIZE_MM + BREGMA_DV_VOXEL;
    next.xRatio = next.voxelZ / VOL_W;
    next.yRatio = next.voxelY / VOL_H;

    const hit = lookupStructure(next.voxelZ, next.voxelY);
    const outside = hit === null;
    const unavailable = !!(hit && hit.unavailable);

    next.region = outside ? 'Outside brain'
                : unavailable ? 'ID map unavailable'
                : hit.acronym;
    next.name = (!outside && !unavailable) ? hit.name : '';
    next.structureId = (!outside && !unavailable) ? hit.id : null;
    next.outsideTissue = outside;
    next.idMapUnavailable = unavailable;

    setSelectedRegionInfo(null);
    setSelectedSearch('');
    setClickedTarget(next);
    if (onTargetSelect) onTargetSelect(next);
  };

  const commitAp = () => {
    const v = parseFloat(draftAp);
    if (Number.isNaN(v) || slices.length === 0) return;
    let closestIdx = 0, minDiff = Infinity;
    slices.forEach((s, idx) => {
      const diff = Math.abs(s.ap_mm - v);
      if (diff < minDiff) { minDiff = diff; closestIdx = idx; }
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
    if (e.key === 'Enter') { e.preventDefault(); fn(); }
  };

  const zoomIn = () => setZoom((z) => Math.min(4, +(z + 0.5).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(2)));
  const zoomReset = () => setZoom(1);

  const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);
  const sw = (n) => n / zoom; // keep stroke weight constant on screen

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

      <div style={styles.toggleRow}>
        <label style={styles.toggle}>
          <input type="checkbox" checked={showBoundaries}
                 onChange={(e) => setShowBoundaries(e.target.checked)} />
          Boundaries
        </label>
        <label style={styles.toggle}>
          <input type="checkbox" checked={showGrid}
                 onChange={(e) => setShowGrid(e.target.checked)} />
          1 mm grid
        </label>
      </div>

      <div style={styles.canvasContainer}>
        <svg
          ref={svgRef}
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          style={styles.svg}
          onClick={handleSvgClick}
        >
          {activeSlice.template_url && (
            <image href={resolveAssetUrl(activeSlice.template_url)}
                   x="0" y="0" width={VOL_W} height={VOL_H}
                   preserveAspectRatio="none" />
          )}
          {showBoundaries && activeSlice.boundary_url && (
            <image href={resolveAssetUrl(activeSlice.boundary_url)}
                   x="0" y="0" width={VOL_W} height={VOL_H}
                   preserveAspectRatio="none"
                   style={{ opacity: 0.45, mixBlendMode: 'screen' }} />
          )}

          {showGrid && (
            <g pointerEvents="none">
              {Array.from({ length: 13 }, (_, i) => i - 6).map((n) =>
                n !== 0 ? (
                  <line key={`ml${n}`}
                        x1={570 + n * 100} y1={0}
                        x2={570 + n * 100} y2={VOL_H}
                        stroke="#334155" strokeWidth={sw(1)} strokeDasharray="3 5" />
                ) : null
              )}
              {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                <line key={`dv${n}`}
                      x1={0} y1={44 + n * 100}
                      x2={VOL_W} y2={44 + n * 100}
                      stroke="#334155" strokeWidth={sw(1)} strokeDasharray="3 5" />
              ))}
              {Array.from({ length: 13 }, (_, i) => i - 6).map((n) =>
                n !== 0 ? (
                  <text key={`mll${n}`} x={570 + n * 100} y={cy - viewH / 2 + 14 / zoom}
                        fill="#64748b" fontSize={13 / zoom} textAnchor="middle">
                    {n > 0 ? `+${n}` : n}
                  </text>
                ) : null
              )}
              {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                <text key={`dvl${n}`} x={cx - viewW / 2 + 5 / zoom} y={44 + n * 100 - 5 / zoom}
                      fill="#64748b" fontSize={13 / zoom}>
                  {n}
                </text>
              ))}
            </g>
          )}

          <line x1="570" y1="0" x2="570" y2={VOL_H}
                stroke="#ef4444" strokeDasharray="6 6" strokeWidth={sw(2)} pointerEvents="none" />
          <line x1="0" y1="44" x2={VOL_W} y2="44"
                stroke="#3b82f6" strokeDasharray="4 4" strokeWidth={sw(2)} pointerEvents="none" />

          {clickedTarget && clickedTarget.voxelZ != null && (
            <g transform={`translate(${clickedTarget.voxelZ}, ${clickedTarget.voxelY})`}
               pointerEvents="none">
              <circle r={16 / zoom} fill="none"
                      stroke={clickedTarget.outsideTissue ? '#64748b' : '#f59e0b'}
                      strokeWidth={sw(3)} />
              <line x1={-22 / zoom} y1="0" x2={22 / zoom} y2="0"
                    stroke={clickedTarget.outsideTissue ? '#64748b' : '#f59e0b'} strokeWidth={sw(2)} />
              <line x1="0" y1={-22 / zoom} x2="0" y2={22 / zoom}
                    stroke={clickedTarget.outsideTissue ? '#64748b' : '#f59e0b'} strokeWidth={sw(2)} />
              <circle r={5 / zoom} fill="#ef4444" />
            </g>
          )}
        </svg>
      </div>

      <div style={styles.sliderSection}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem' }}>
          <span>AP Position:</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="number" step="0.05" value={activeSlice.ap_mm}
                   onChange={handleApInput} style={styles.apInput} />
            <span>mm</span>
          </div>
        </div>
        <input type="range" min={0} max={slices.length > 0 ? slices.length - 1 : 0}
               value={sliceIndex} onChange={(e) => setSliceIndex(Number(e.target.value))}
               style={{ width: '100%', marginTop: '6px' }} />
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

        {clickedTarget && clickedTarget.outsideTissue && (
          <div style={styles.warnBadge}>⚠ Outside brain tissue — no structure assigned</div>
        )}
        {clickedTarget && clickedTarget.idMapUnavailable && (
          <div style={styles.warnBadge}>Structure-ID map not loaded for this slice</div>
        )}
        {clickedTarget && !clickedTarget.outsideTissue && !clickedTarget.idMapUnavailable && (
          <div style={styles.regionBadge}>
            CCF: {clickedTarget.region}
            {clickedTarget.name ? <span style={styles.regionBadgeSub}> — {clickedTarget.name}</span> : null}
          </div>
        )}

        <div style={styles.manualEntry}>
          <span style={styles.coordLabel}>AP</span>
          <input type="number" step="0.05" value={draftAp} placeholder="—"
                 onChange={(e) => setDraftAp(e.target.value)}
                 onBlur={commitAp} onKeyDown={onKeyCommit(commitAp)}
                 style={styles.manualInput} />
          <span style={styles.coordUnit}>mm</span>

          <span style={styles.coordLabel}>ML</span>
          <input type="number" step="0.05" value={draftMl} placeholder="—"
                 onChange={(e) => setDraftMl(e.target.value)}
                 onBlur={commitMl} onKeyDown={onKeyCommit(commitMl)}
                 style={styles.manualInput} />
          <span style={styles.coordUnit}>mm</span>

          <span style={styles.coordLabel}>DV</span>
          <input type="number" step="0.05" value={draftDv} placeholder="—"
                 onChange={(e) => setDraftDv(e.target.value)}
                 onBlur={commitDv} onKeyDown={onKeyCommit(commitDv)}
                 style={styles.manualInput} />
          <span style={styles.coordUnit}>mm</span>
        </div>

        {!clickedTarget && (
          <p style={{ color: '#64748b', fontSize: '0.78rem', margin: '8px 0 0 0' }}>
            Type coordinates above, or click/search a slice. DV is positive-down (ventral).
          </p>
        )}

        <p style={styles.caveat}>
          Region resolved from the Allen CCFv3 annotation volume (25 µm voxel lookup).
          Always verify against a printed atlas before surgery.
        </p>
      </div>
    </div>
  );
}

const styles = {
  sidebarContainer: { display: 'flex', flexDirection: 'column', gap: 12, padding: 14, color: '#f8fafc' },
  heading: { margin: '0 0 4px 0', fontSize: '1.05rem' },
  searchSection: { width: '100%' },
  searchInput: { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #475569', backgroundColor: '#0f172a', color: '#fff', fontSize: '0.85rem', boxSizing: 'border-box' },
  canvasContainer: { backgroundColor: '#000', borderRadius: 6, overflow: 'hidden', border: '1px solid #334155', height: '52vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  svg: { width: '100%', height: '100%', display: 'block', cursor: 'crosshair' },
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
  warnBadge: { fontSize: '0.8rem', color: '#fbbf24', backgroundColor: '#78350f30', border: '1px solid #b45309', borderRadius: 4, padding: '4px 8px', marginBottom: 8 },
  manualEntry: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '6px 8px', alignItems: 'center' },
  manualInput: { width: '100%', padding: '4px 6px', borderRadius: 4, border: '1px solid #475569', backgroundColor: '#1e293b', color: '#fff', fontSize: '0.82rem', boxSizing: 'border-box' },
  coordLabel: { color: '#f59e0b', fontWeight: 600, fontSize: '0.82rem' },
  coordUnit: { color: '#64748b', fontSize: '0.75rem' },
  caveat: { color: '#64748b', fontSize: '0.72rem', margin: '10px 0 0 0', lineHeight: 1.4 }
};