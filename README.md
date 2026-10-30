# CG Marry-Up Tracker

Mobile-first, offline web app for warehouse inbound. Each Consolidation Group (CG) usually
arrives as 2 metrocarts on different trucks. Scan every cart as it comes in; the app tells you
which CGs are complete (all carts here, marry them up) and which are still waiting.

- Live (main): https://kyushira.github.io/cg-tracker/
- Branch previews: https://kyushira.github.io/cg-tracker/preview/<branch-slug>/
  (e.g. `feat/mvp` -> `/preview/feat-mvp/`)

## Using it on the floor

1. Open the link on the phone or handheld and "Add to Home Screen". After the first load it
   works with no signal.
2. Optional: tap the **OPS** chips (10, 20, 30, 60, 70, 80, pick as many as apply; **Others**
   opens a short text box) and one **MC TYPE** (Big MC, Small MC, Open MC). They stay selected
   for every scan until you change them. Tap a selected chip again to turn it off.
3. **Scan the CG label** into the big box (the scanner presses Enter for you; by hand, type the
   number and tap **Receive cart**). A CG is exactly **4 digits**; anything else shows a red
   **NOT SAVED** message with a warning buzz and is not recorded. Scanner prefix/suffix
   characters and spaces are stripped first.
   - First cart: amber **PENDING 1/2**, one short beep. Stage the cart.
   - Last cart: full-screen green **COMPLETE** with a check, three-tone beep and vibration.
     Marry the carts up.
4. The app asks before saving when:
   - the CG already has all its carts, or
   - the same CG was scanned in the last 60 seconds (double scan?).
   **Cancel** is pre-selected, so an accidental scanner Enter never saves a duplicate.
5. **Undo** removes the last scan (asks first).
6. Tabs (bottom bar):
   - **Pending**: oldest first, time waiting, and the ops/MC type of the first cart. Orange
     **AGING** = waiting 75% of the alert time (default 18h of 24h), red **LATE** = past it.
   - **Completed**: receive time, ops and MC type of each cart. Tap **Married & staged** or **Dispatched** to clear
     it from the active list; the filter chips (Staged / Dispatched / All) bring them back.
   - **Search**: any part of a CG number, shows status and full scan history.
   - **More**: aging alert hours, **Download CSV** (one row per cart; `ops` column like `10;30`,
     `mc_type` column like `Big MC`), and **Clear all data** (type `DELETE` to confirm).
7. Tap any CG to open it: change how many carts it expects (1-9, default 2), edit a scan's CG,
   ops, MC type or time, delete a scan, or mark it staged/dispatched.

Data saved by the first test version (truck/door fields) still loads; those two fields are
dropped and the scans show "No ops / MC".

Data lives only in this browser on this device (localStorage). Clearing browser data deletes
it, so export a CSV at the end of each shift. Each preview URL keeps its own separate data.
Vibration doesn't work on iPhones (Safari has no vibration API); the beep and green screen still do.

## Developing

```sh
npm ci
npm run dev        # local server with hot reload
npm test           # unit tests (domain rules + storage)
npm run typecheck
npm run build      # -> dist/, includes the generated service worker dist/sw.js
npm run preview    # serve dist/ locally
```

Code layout:

- `src/domain.ts` - all rules (matching, duplicates, aging, CSV), pure functions over `AppData`.
- `src/storage.ts` - `DataStore` interface plus `LocalStore` (localStorage, key namespaced by
  page path). A Supabase sync store can implement the same interface later without touching the
  rules or the UI.
- `src/App.tsx` - UI. `src/feedback.ts` - beep and vibration.
- `sw-template.js` - service worker; `vite.config.ts` fills in the list of built files to precache.

## Deploying

GitHub Actions (`.github/workflows/ci.yml`) on every push:

- `check`: `npm ci`, typecheck, tests, build.
- `publish` (after `check` passes): `main` goes to the site root, any other branch to
  `/preview/<branch-slug>/`, all on the `gh-pages` branch.
- Deleting a branch removes its preview.

One-time setup on GitHub: **Settings -> Pages -> Build and deployment -> Source: Deploy from a
branch -> `gh-pages` / `(root)`**. Merges to `main` need the owner's approval.
