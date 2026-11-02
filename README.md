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
   number and tap **Receive cart**). The team calls a CG by its **last 4 digits**:
   - type the 4 digits (e.g. `4821`), or
   - scan the full barcode, which starts with `8000` (e.g. `80001234821`).
   Both are the same CG `4821`; a scan also keeps the full barcode (shown small in the scan
   history and in the CSV `raw_code` column). Anything else (letters, fewer than 4 digits, or
   more than 4 digits without the `8000` start) shows a red **NOT SAVED** message with a
   warning buzz and is not recorded. Scanner prefix/suffix characters and spaces are stripped
   first.
   - First cart of a new CG: saved straight away. Amber **PENDING 1/2**, one short beep, and
     where to put it: **Put in A5 · partner → A6** (A6 is now reserved for the partner).
   - A CG that already has carts but isn't complete is **never saved straight away**. The app
     asks **"Is this the 2nd MC?"** and shows where the first half is (slot, ops, MC type, time
     waiting). Tap **COMPLETE IT** to save it, or **Just checking** to save nothing. So typing a
     CG is a safe way to check whether its partner has arrived. **Just checking** is
     pre-selected and the dialog ignores taps/Enter for its first ⅓ second, so a scanner's Enter
     can never complete a CG by accident.
   - Completing cart: full-screen green **COMPLETE** with a check, three-tone beep, vibration,
     and **Put in A6, next to its partner**. Marry the carts up.
4. The app also asks before saving when the CG already has all its carts (an extra cart).
   **Cancel** is pre-selected.
5. **Undo** removes the last scan (asks first) and frees that cart's slot.
6. Tabs (bottom bar):
   - **Receive**: the only screen that receives carts. Below the scan box:
     - **Pending**: oldest first, slots, time waiting, and the ops/MC type of the first cart.
       Orange **AGING** = waiting 75% of the alert time (default 18h of 24h), red **LATE** = past it.
     - **Completed**: receive time, slot, ops and MC type of each cart. **Married & staged**
       keeps the carts in their slots; **Dispatched** frees the slots. The filter chips
       (Active / Staged / Dispatched / All) show each group.
   - **Staging**: the floor map. Rows **A** and **B**, 11 slots each by default. A pair always
     sits side by side in one row (A5+A6), never across rows; CGs expecting 1 or 3 carts get 1
     or 3 adjacent slots. Green = married, amber = waiting (orange/red when aging), dashed box =
     reserved for the partner, grey = empty. When the normal slots are full, numbering carries
     on (A12, A13…), the row scrolls sideways and the header turns orange: **Staging 24/22 ·
     over by 2**. With 11 slots, slot 11 of each row only fits a 1-cart CG, so a pair may go to
     overflow while A11/B11 are still empty. Slots are only freed by marking a CG
     **Dispatched**; nothing clears on its own. Tap a slot to see the CG and **Move…** it to
     another free slot pair.
   - **Search**: a read-only database of every CG, newest first. Search by the 4 digits or any
     part of a barcode, filter All / Pending / Complete / Staged / Dispatched. It cannot receive
     carts.
   - **More**: slots per row, aging alert hours, **Download CSV** (one row per cart; `cg` is the
     4-digit key, `raw_code` the full code as typed/scanned, `slot` like `A5`, `ops` like
     `10;30`, `mc_type` like `Big MC`), and **Clear all data** (type `DELETE` to confirm).
7. Tap any CG (in any list or on the map) to open it: its slots and **Move…**, how many carts it
   expects (1-9, default 2), edit a scan's CG, ops, MC type or time, delete a scan, or mark it
   staged/dispatched. These correct records; they never receive a new cart.

Data saved by the first test version (truck/door fields) still loads; those two fields are
dropped and the scans show "No ops / MC". CGs received before the staging map have no slot;
the Staging tab lists them so you can assign one, and the next scan of such a CG gives all its
carts slots.

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
- `src/staging.ts` - staging map rules (slot blocks per CG, overflow, freeing on dispatch); the
  UI calls its `receive` / `removeScan` / `mark` / `moveCg` wrappers so slots stay consistent.
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
