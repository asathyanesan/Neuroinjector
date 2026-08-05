// UD Neuroinjector syringe configurator
// Everything here runs client-side: load the syringe JSON DB, let the user pick
// models, and splice generated code into the marked regions of injector_control.ino.

const DATA_URL = "data/hamilton_syringes.json";
const TEMPLATE_URLS = [
  "../injector_control_stepper/injector_control.ino", // lives in the repo alongside /webapp
  "injector_control_template.ino", // bundled fallback copy
];

const MAX_PRESETS = 7; // digits '1'-'7'; '8' = Custom, '9' = Exit

let db = null;
let templateText = null;
const customSyringes = []; // {id, displayName, volumeUl, strokeLengthMm, divNlPerMm}

function escapeForCpp(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function makeConstName(displayLabel, index) {
  let base = String(displayLabel)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base || /^[0-9]/.test(base)) base = "S" + base;
  return `SYR_${index + 1}_${base}_DIV`;
}

async function fetchFirstAvailable(urls) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.text();
    } catch (e) {
      /* try next */
    }
  }
  throw new Error("Could not load injector_control.ino template from any known location.");
}

async function init() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  db = await res.json();

  renderSyringeList();
  renderReferenceTable();
  updateDefaultSelect();

  document.getElementById("custom-form").addEventListener("submit", onAddCustom);
  document.getElementById("generate-btn").addEventListener("click", onGenerate);
  document.getElementById("download-btn").addEventListener("click", onDownload);

  try {
    templateText = await fetchFirstAvailable(TEMPLATE_URLS);
    updateDefaultSelect();
  } catch (e) {
    showError(e.message);
  }
}

function renderSyringeList() {
  const container = document.getElementById("syringe-list");
  container.innerHTML = "";
  for (const s of db.syringes) {
    const card = document.createElement("div");
    card.className = "syringe-card";
    const checked = s.isDefault ? "checked" : "";
    card.innerHTML = `
      <input type="checkbox" id="chk-${s.id}" data-id="${s.id}" ${checked} />
      <label for="chk-${s.id}">
        <div class="model-name">${s.displayName}</div>
        <div class="model-meta">${s.seriesFamily} &middot; ${s.divNlPerMm.toFixed(3)} nL/mm &middot; ${s.volumeUl} µL over ${s.strokeLengthMm} mm stroke</div>
      </label>`;
    container.appendChild(card);
    card.querySelector("input").addEventListener("change", updateDefaultSelect);
  }
}

function renderReferenceTable() {
  const tbody = document.querySelector("#reference-table tbody");
  tbody.innerHTML = "";
  const rows = [
    ...db.syringes.map((s) => ({
      model: s.displayName,
      volume: `${s.volumeUl} µL`,
      od: `${s.barrelOdMm} mm`,
      stroke: `${s.strokeLengthMm} mm`,
      div: s.divNlPerMm,
      compatible: s.hardwareCompatible,
      note: s.note || "",
    })),
    ...db.genericReference.map((g) => ({
      model: `${g.series} (generic)`,
      volume: g.volumeLabel,
      od: g.barrelOdMm != null ? `${g.barrelOdMm} mm` : "—",
      stroke: g.strokeLengthMm != null ? `${g.strokeLengthMm} mm` : "—",
      div: g.divNlPerMm,
      compatible: g.hardwareCompatible,
      note: g.note || "",
    })),
  ];
  for (const r of rows) {
    const tr = document.createElement("tr");
    const divText = typeof r.div === "number" ? r.div.toFixed(3) : "—";
    tr.innerHTML = `<td>${r.model}</td><td>${r.volume}</td><td>${r.od}</td><td>${r.stroke}</td><td>${divText}</td><td>${r.compatible ? "Yes" : "No"}</td><td>${r.note}</td>`;
    tbody.appendChild(tr);
  }
}

function onAddCustom(evt) {
  evt.preventDefault();
  const name = document.getElementById("custom-name").value.trim();
  const volume = parseFloat(document.getElementById("custom-volume").value);
  const stroke = parseFloat(document.getElementById("custom-stroke").value);
  const directDiv = parseFloat(document.getElementById("custom-div").value);

  let divNlPerMm;
  if (!isNaN(directDiv) && directDiv > 0) {
    divNlPerMm = directDiv;
  } else if (!isNaN(volume) && volume > 0 && !isNaN(stroke) && stroke > 0) {
    divNlPerMm = (volume * 1000) / stroke;
  } else {
    showError("Enter either a direct nL/mm value, or both a volume and stroke length.");
    return;
  }
  if (!name) {
    showError("Give the custom syringe a name.");
    return;
  }
  showError("");

  const id = `custom-${Date.now()}`;
  customSyringes.push({ id, displayName: name, volumeUl: volume || null, strokeLengthMm: stroke || null, divNlPerMm });
  renderCustomList();
  updateDefaultSelect();
  evt.target.reset();
}

function renderCustomList() {
  const list = document.getElementById("custom-list");
  list.innerHTML = "";
  for (const c of customSyringes) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${c.displayName} &mdash; ${c.divNlPerMm.toFixed(3)} nL/mm</span>`;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", () => {
      const idx = customSyringes.findIndex((s) => s.id === c.id);
      if (idx >= 0) customSyringes.splice(idx, 1);
      renderCustomList();
      updateDefaultSelect();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function getSelectedSyringes() {
  const selected = [];
  for (const s of db.syringes) {
    const chk = document.getElementById(`chk-${s.id}`);
    if (chk && chk.checked) {
      selected.push({ id: s.id, displayName: s.displayName, divNlPerMm: s.divNlPerMm });
    }
  }
  for (const c of customSyringes) {
    selected.push({ id: c.id, displayName: c.displayName, divNlPerMm: c.divNlPerMm });
  }
  return selected;
}

function updateDefaultSelect() {
  const select = document.getElementById("default-select");
  const prevValue = select.value;
  select.innerHTML = "";
  const selected = getSelectedSyringes();
  for (const s of selected) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.displayName;
    select.appendChild(opt);
  }
  if (selected.some((s) => s.id === prevValue)) select.value = prevValue;
  document.getElementById("generate-btn").disabled = selected.length === 0 || !templateText;
}

function showError(msg) {
  document.getElementById("generate-error").textContent = msg || "";
}

function buildIno(selected, defaultId) {
  if (selected.length === 0) throw new Error("Select at least one syringe.");
  if (selected.length > MAX_PRESETS) {
    throw new Error(`Too many syringes selected (${selected.length}). Max supported is ${MAX_PRESETS} (single serial-menu digits).`);
  }

  const withConsts = selected.map((s, i) => ({ ...s, constName: makeConstName(s.displayName, i) }));

  const constantsBlock = withConsts
    .map((s) => `const float ${s.constName} = ${s.divNlPerMm.toFixed(6)}; // ${escapeForCpp(s.displayName)}`)
    .join("\n");

  const customDigit = withConsts.length + 1;
  const exitDigit = withConsts.length + 2;

  const menuBlock =
    "  " +
    [
      ...withConsts.map((s, i) => `Serial.println(F("\`${i + 1}\` - ${escapeForCpp(s.displayName)}"));`),
      `Serial.println(F("\`${customDigit}\` - Custom"));`,
      `Serial.println(F("\`${exitDigit}\` - Exit without changing"));`,
    ].join("\n  ");

  const casesBlockParts = [
    ...withConsts.map(
      (s, i) => `case '${i + 1}':
        syringe_div = ${s.constName};
        Serial.println(F("${escapeForCpp(s.displayName)} Selected.\\n"));
        selected = true;
        break;`
    ),
    `case '${customDigit}':
        syringe_div = get_div();
        Serial.println(F("Custom syringe set.\\n"));
        selected = true;
        break;`,
    `case '${exitDigit}':
        Serial.println(F("Syringe not updated.\\n"));
        selected = true;
        break;`,
  ];
  const casesBlockJoined = "      " + casesBlockParts.join("\n      ");

  const defaultSyringe = withConsts.find((s) => s.id === defaultId) || withConsts[0];
  const defaultBlock = `  syringe_div = ${defaultSyringe.constName};
  Serial.println(F("Run keyboard control"));
  Serial.println(F("This Injector is controlled through serial communication."));
  Serial.println(F("Default Syringe: ${escapeForCpp(defaultSyringe.displayName)}"));`;

  let out = templateText;
  out = replaceBetween(out, "SYRINGE_CONSTANTS_START", "SYRINGE_CONSTANTS_END", constantsBlock);
  out = replaceBetween(out, "SYRINGE_MENU_START", "SYRINGE_MENU_END", menuBlock);
  out = replaceBetween(out, "SYRINGE_CASES_START", "SYRINGE_CASES_END", casesBlockJoined);
  out = replaceBetween(out, "SYRINGE_DEFAULT_START", "SYRINGE_DEFAULT_END", defaultBlock);
  return out;
}

function replaceBetween(text, startMarker, endMarker, replacement) {
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Could not find template markers ${startMarker}/${endMarker} in injector_control.ino. The firmware file may be out of sync with this web app.`);
  }
  // Drop both whole marker-comment lines and splice the replacement in between them.
  const startLineStart = text.lastIndexOf("\n", startIdx) + 1;
  const endLineNewline = text.indexOf("\n", endIdx);
  const endLineStop = endLineNewline === -1 ? text.length : endLineNewline + 1;
  return text.slice(0, startLineStart) + replacement + "\n" + text.slice(endLineStop);
}

let lastGenerated = null;

function onGenerate() {
  showError("");
  try {
    const selected = getSelectedSyringes();
    const defaultId = document.getElementById("default-select").value;
    lastGenerated = buildIno(selected, defaultId);
    document.getElementById("preview").textContent = lastGenerated;
    document.getElementById("preview-details").open = true;
    document.getElementById("download-btn").disabled = false;
  } catch (e) {
    lastGenerated = null;
    document.getElementById("download-btn").disabled = true;
    showError(e.message);
  }
}

function onDownload() {
  if (!lastGenerated) return;
  const blob = new Blob([lastGenerated], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "injector_control.ino";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

init();
