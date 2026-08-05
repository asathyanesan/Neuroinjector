# UD Neuroinjector — Syringe Configurator (Web App)

A static, client-side-only web app for generating a customized
`injector_control.ino` for whichever Hamilton syringe(s) you're using. No data
leaves your browser and no build step or server is required.

## Using it

- **Hosted version:** enable GitHub Pages for this repository (Settings →
  Pages → Deploy from branch → `main` → `/ (root)`), then visit
  `https://<your-org-or-user>.github.io/<repo>/webapp/`.
- **Locally:** serve this folder with any static file server, e.g.
  `npx serve webapp` or `python -m http.server` from inside `webapp/`, then
  open the printed URL. Opening `index.html` directly via `file://` will not
  work because browsers block `fetch()` of local files.

## How it works

1. `data/hamilton_syringes.json` is a small database of Hamilton syringe
   models (volume, plunger stroke length, and the resulting nL/mm dispense
   rate) built from Hamilton's official specification sheets and their
   Syringe & Needle Reference Guide.
2. You check off which syringe(s) you own (or add a custom one by volume +
   stroke length, or a directly-known nL/mm rate).
3. The app fetches the real `injector_control.ino` firmware (from
   `../injector_control_stepper/injector_control.ino`, falling back to the
   bundled `injector_control_template.ino` copy) and splices your selection
   into the four `SYRINGE_*_START`/`SYRINGE_*_END` marker regions in that
   file — the constants, the serial menu text, the `switch` cases, and the
   power-on default. No LLM, server, or network call (besides loading the
   two static files) is involved.
4. Click **Generate**, review the preview, then **Download** the resulting
   `.ino` and open it in the Arduino IDE / VS Code Arduino extension to flash
   it, per the instructions in the repo's main [ReadMe](../ReadMe.md).

## Keeping the template in sync

If `injector_control_stepper/injector_control.ino` changes in ways that touch
the syringe-selection code, update the matching marker comments there and
copy the file over `webapp/injector_control_template.ino` (the offline
fallback) so both stay in sync.

## Updating the syringe database

`data/hamilton_syringes.json` documents its own derivation in its `notes`
field: `divNlPerMm = (volumeUl * 1000) / strokeLengthMm`. To add a new
Hamilton model, look up its rated volume and plunger stroke length (Hamilton's
"Syringe Dimensions" table, or a part-specific spec sheet) and add an entry
following the existing schema.
