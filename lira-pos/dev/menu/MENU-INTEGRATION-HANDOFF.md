# Official menu integration — handoff (2026-11-23)

## Outcome

| | |
|---|---|
| Commit | `19fb4d2` "V1.2.0: Greaz's official menu, bundled and loaded once by the owner" on `sandbox/greaz-training`. **Not pushed.** |
| Release notes | `docs/V1.2.0-RELEASE-NOTES.md` (acceptance results included) |
| Owner/developer guide | `docs/OFFICIAL-MENU.md` |
| Installers | `dev/release-v1.2.0-19fb4d2/` (Production NSIS + MSI), `dev/release-v1.2.0-19fb4d2-training/` (Training NSIS) — hashes in the release notes and each `SHA256SUMS` |
| Independent review | Codex CLI 0.157.1, read-only: r1 BLOCKED (P0/P1/P2) → r2 BLOCKED (P0) → r3 BLOCKED (P0) → **r4 PASS** |
| Gate | `npm run verify` green on the final tree (1,227 Vitest / 1,129 Rust). In the clean build worktree, run after the build: 1,227 Vitest, Rust 1,128/1,129; the one failure was a pre-existing CRLF-sensitive source-text test, proven and fixed test-only in `5000dbe` |
| Follow-up commit | `5000dbe` docs: release notes + that test fix (no application code) |
| **Desktop acceptance** | **PASSED 2026-11-23**: Fresh 28/28, Restart 8/8, Existing database 41/41, Training 28/28, isolation PASS. Earlier failures were harness errors, not application defects. See "Desktop acceptance". |

## Source of truth

`dev/greaz_menu_seed_reference.json` (founder-supplied), validated: 27 menu
items (Burgers 7, Wraps 4, Fries 6, Appetizers 5, Combos 2, Drinks 2,
Dessert 1), 4 add-ons, 2 upgrades, 9 categories, 3 choice groups, 33 unique
SKUs, OG Chicken as `GRZ-BUR-003` and `GRZ-WRP-002`. Bundled unchanged as
`src/catalog/greaz-menu-v1.json` (SHA-256 `8a2fc1c6…886dd`), `-text` in
`.gitattributes` so a CRLF checkout cannot alter it. The older 17-item design
fixture and the MilkyWay PDFs were not used.

## Design decisions (and why)

1. **Not a migration, not run at launch.** The menu has no VAT treatment and
   `vat_rate_id` is NOT NULL; seeding would have to invent one. The owner loads
   it once, after enrollment, from a prompt on the Register (owner only) or
   Products → Official menu.
2. **Tax treatment is an explicit owner decision.** VAT rate + "printed prices
   include VAT / VAT on top" + confirmation, none defaulted; the backend
   refuses without all three.
3. **Non-stock menu items, no cost, no recipe, no barcode.** Sellable at once;
   sales show as uncosted until recipes are published. Ingredients stay
   separate (stocked, "inventory only").
4. **Coming Soon dessert**: created with `show_on_register = 0`; `post_sale`
   refuses it.
5. **Existing databases**: existing SKU → skipped; same name on the Register →
   kept unless "Replace" ticked (bound to the exact product ids reviewed);
   other Register items → hidden only if ticked. Only `show_on_register = 0` is
   ever written to an existing product. Plan recomputed in the transaction.
   Marker per store; second load refused.
6. **Choices via kitchen notes, not a modifier engine.** Free sauce/dip
   choices prompt on add and become the line's kitchen note; paid add-ons and
   upgrades are priced lines. Nothing posts while a choice is open; a choice or
   a scan never joins an order other than its own.

## Owner decisions still open (the app takes the permissive reading)

VAT rate and inclusive/exclusive (chosen at load); combo-upgrade eligibility
(any item); repeat dips in the Greaz Box (allowed); add-on applicability (any);
soft-drink flavours and stock tracking (one non-stock Soft Drink); any other
unavailable items.

## Desktop acceptance (2026-11-23) — PASSED

| Phase | Identity / port | Result | Evidence |
|---|---|---|---|
| Fresh install | menufresh / 9371 | **28/28** | `dev/menu/evidence/fresh/` |
| Restart (after an unplanned PC shutdown; DB integrity checked first) | menufresh / 9371 | **8/8** | same folder, `results-restart.json` |
| Existing database (corrected rerun) | menuexist / 9372 | **41/41** + offline 36-table, 276-row comparison | `dev/menu/evidence/exist-rerun/`; run 1 in `exist/` |
| Training edition | menutrn / 9373 | **28/28** | `dev/menu/evidence/trn/` |
| Isolation | — | **PASS**: other disposables untouched; protected Production/Training byte-identical | scratchpad fingerprints |

Full description in `docs/V1.2.0-RELEASE-NOTES.md`, "Desktop acceptance".

**Harness errors, not application defects** (each corrected so the
expectation is derived, not loosened):

1. Tab-order regex anchored on `^All`; theme buttons also carry `aria-pressed`.
2. Snapshot read `users.*` / `users.rowid`; the read guard rightly refuses
   credential columns and rowid even to the owner.
3. `product_uoms` compared as a whole table, so new units counted as changes.
4. "33 created" on an existing DB: Curly Fries and Water were KEPT (same name,
   Replace not ticked), by design — 31 created, load record agrees.
5. "32 tiles" is a fresh-store number; existing DB expects 14 − 1 + 30 = 43.

The owner's `users.updated_at` moves on sign-in (`auth.rs` resets
`failed_attempts`), not on the load. Same-named kept items keep their own
price (Water stayed $6.50 vs printed $0.50) — tell the owner to tick Replace or
fix the price.

**How it was run.** Launching the app with a CDP port is refused to the agent by
the session's permission classifier, so the owner launched each disposable exe
from their own PowerShell; the app's ACL also refuses a scripted window close,
so the owner closed each window too:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9371 --remote-debugging-address=127.0.0.1"
& "...\lira-pos\src-tauri\target\release\GreazPOS-MenuFresh.exe"
```

```sh
# untracked overlays in src-tauri/: tauri.menufresh / menuexist / menutrn .conf.json
npx tauri build --config src-tauri/tauri.menufresh.conf.json --no-bundle
node dev/menu/walkthrough.mjs 9371 com.greazlb.pos.menufresh fresh   dev/menu/evidence/fresh
#   owner closes the window and relaunches, then:
node dev/menu/walkthrough.mjs 9371 com.greazlb.pos.menufresh restart dev/menu/evidence/fresh

# existing-database safety: copy the DISPOSABLE V1.1 acceptance database
#   %APPDATA%\com.greazlb.pos.v11acc\greaz-pos.db{,-wal,-shm}
#   into a NEW %APPDATA%\com.greazlb.pos.menuexist\ (app closed), build with
#   tauri.menuexist.conf.json, launch on another port, then:
node dev/menu/walkthrough.mjs 9372 com.greazlb.pos.menuexist exist dev/menu/evidence/exist

# Training edition: build with tauri.menutrn.conf.json (sandbox frontend), run `fresh`.
```

The script refuses any identity but those three. Phases cover: no silent
seed, the prompt, the dialog (Load disabled until tax confirmed), all 33 rows
and prices, Register tabs in order and 32 tiles (no dessert, no ingredients),
descriptions, no horizontal scroll at 1366x768, a sale rung by real clicks and
F5 with sauce and dips, OG Chicken burger and wrap, add-on and upgrade lines,
Coming Soon refused, restart persistence, second load refused, and on the
copied V1.1 database every pre-existing row of 17 tables unchanged.

**Installers.** Re-checked after acceptance: `SHA256SUMS` verifies in both
release folders, `SOURCE-COMMIT` is `19fb4d2`, no application source or config
changed since, so they were not rebuilt.

**Still for a human:** install the real installers on the till; the owner's VAT
decision; actual Windows 125 % scaling, a physical keyboard and scanner,
printed kitchen ticket and receipt; the open menu decisions above.

## Protected data

Fingerprints of `%APPDATA%\com.greazlb.pos\greaz-pos.db*` and
`%APPDATA%\com.greazlb.pos.training\greaz-pos.db*` (name, size, mtime,
SHA-256) were identical before any work, after the release build, and after
the desktop acceptance campaign. They were never opened. No historical
migration was edited. Nothing was pushed.
