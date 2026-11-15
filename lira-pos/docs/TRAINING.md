# Greaz POS — Training edition

The Training edition is the **V1 application, built from the same source commit
as Production** (`518e4f81ef4a144e7074f040412c75eea12acda6`), with one extra
file: the overlay `src-tauri/tauri.training.conf.json`. No source file,
migration, posting rule, VAT rule or calculation differs. Staff practise on
exactly what they will use, against a database that is not the shop's.

## The installer

| | |
|---|---|
| File | `Greaz POS Training_0.1.0_x64-setup.exe` |
| Location (development machine, untracked) | `lira-pos/dev/release-v1-518e4f8-training/` |
| Bytes | 4,122,490 |
| SHA-256 | `a333de4f4eb5e9027709fe92cc75dd1970f8f830323eaf892df0d594054d634d` |
| Overlay config SHA-256 | `76140ec73b693b24c824a200c4fc99fa36d9df3078f92d075395d194e21c6abc` |
| Built | 2026-11-15T12:40–12:42Z, clean detached worktree of `518e4f8` + the overlay, `npm ci` from the committed lockfiles, `npx tauri build --config src-tauri/tauri.training.conf.json` |
| Code signing | **NONE.** SmartScreen will warn. |

The archive folder also holds `build-transcript.log`, `SHA256SUMS.txt`,
`SOURCE-COMMIT.txt`, a copy of the overlay, and `evidence/` (the side-by-side
acceptance below). Verify before installing:
`Get-FileHash '<file>' -Algorithm SHA256`.

The Production installers of record are unchanged (see `V1-RELEASE-NOTES.md`).
Nothing in this work rebuilt, modified or replaced them.

## What differs from Production, and why each one matters

|  | Production | Training |
|---|---|---|
| Product name (Apps list, Start menu, install folder) | `Greaz POS` | `Greaz POS Training` |
| Window title / taskbar | `Greaz POS` | `Greaz POS — Training — PRACTICE DATA ONLY` |
| Executable | `lira-pos.exe` | `GreazPOS-Training.exe` |
| Identifier | `com.greazlb.pos` | `com.greazlb.pos.training` |
| Install folder (per-user NSIS) | `%LOCALAPPDATA%\Greaz POS` | `%LOCALAPPDATA%\Greaz POS Training` |
| Uninstall entry | `HKCU\…\Uninstall\Greaz POS` | `HKCU\…\Uninstall\Greaz POS Training` |
| Database | `%APPDATA%\com.greazlb.pos\greaz-pos.db` | `%APPDATA%\com.greazlb.pos.training\greaz-pos.db` |
| Single-instance mutex | `Global\GreazPOS.com.greazlb.pos.<SID>` | `Global\GreazPOS.com.greazlb.pos.training.<SID>` |
| On screen | — | amber "TRAINING / SANDBOX — DATA IS NOT REAL" strip on every screen, "COUNTER · TRAINING" in the sidebar (the existing `--mode sandbox` build; tree-shaken out of Production) |
| Bundle targets | NSIS + MSI | NSIS only |

**The executable name is a functional difference, not cosmetic.** The Tauri NSIS
installer and uninstaller find a running copy of the app *by executable name*
(`FindProcessCurrentUser "<MAINBINARYNAME>.exe"`) and close it. In silent mode
they close it without asking. If both editions were `lira-pos.exe`, installing,
updating or uninstalling Training would close a running Production till. The
side-by-side test below proves the distinct name prevents that.

The identifier moves the database, the WebView2 profile and the mutex together.
For how both the frontend and Rust resolve the database from it, see
`SANDBOX.md` §1. The Training uninstaller's optional "delete app data" box
removes exactly `%APPDATA%\com.greazlb.pos.training` and
`%LOCALAPPDATA%\com.greazlb.pos.training`, never a prefix match. A silent
uninstall leaves it unticked and keeps the practice data.

A fresh Training install starts at owner enrollment, with its own one-time code
written under its own folder. No Production data or credential is copied in.
Do not copy a Production database into the Training folder: that would put
real sales and real credentials on a practice machine.

## Side-by-side acceptance (2026-11-15)

Real WebView2 evidence. The Training installer and a **production-shaped**
build were both installed on one machine and run at the same time, driven over
CDP (`dev/training_side_by_side.mjs`). The production-shaped build is the same
commit with the production frontend and the default `lira-pos.exe` name, under
the disposable identity `com.greazlb.pos.trnsideprod`. The real Production
identity was never installed or launched, because its database on this machine
is protected data.

| Check | Result |
|---|---|
| Both installed side by side: separate folders, uninstall entries, exe names | PASS |
| Both running at once; each holds its own mutex, the real Production mutex held by neither | PASS |
| Training window title (U+2014 dashes verified) | PASS |
| A second Training launch is refused before it opens the database | PASS |
| Each edition: fresh enrollment under its own folder, own owner + cashier, own product, shift, sale | PASS |
| Each edition refuses the other edition's owner passphrase and has no record of its cashier | PASS |
| Each edition holds only its own sale, shift, user and product; each has its own receipt sequence (both receipt #1) | PASS |
| Training marking present in Training only; absent from the production-shaped build | PASS |
| Silent **update** of Training while both run: Training closed and reinstalled, production-shaped process untouched | PASS |
| After update: both still enrolled, credentials, sale and open shift intact | PASS |
| Silent **uninstall** of Training while the production-shaped build runs: folder and uninstall entry removed, practice data kept, production-shaped app still signs in and holds its sale and open shift | PASS |
| Every pre-existing Greaz data file under `%APPDATA%` (67 files, including the 4 protected `com.greazlb.pos` files) is byte-identical before and after | PASS |

Two harness assertions failed on the first run and were corrected; they were
not product faults. A "register renders" pattern looked for a button that an
empty cart does not show (the screens were confirmed to show the register with
the shift open), and a verify phase did not sign out a process still signed in
from the previous phase.

Not covered: actual Windows 125% scaling, a second physical PC, and installing
Training on a machine that also has the *real* Production installed. Do the last
one on the till during rollout, with Production closed, and check that the
Production icon still opens Production.

## Rebuilding

```sh
# from lira-pos/, at the release commit, with the overlay present
npx tauri build --config src-tauri/tauri.training.conf.json
# -> src-tauri/target/release/bundle/nsis/Greaz POS Training_0.1.0_x64-setup.exe
```

A rebuild is a new artifact. Record its SHA-256; do not assume it matches the
one above.

## 1.1.0

The Training edition keeps the same identity (`com.greazlb.pos.training`,
`GreazPOS-Training.exe`, `%APPDATA%\com.greazlb.pos.training`), so installing
1.1.0 Training over 0.1.0 Training updates it in place and keeps the practice
data. What is new for Training specifically: its own yellow-and-black icon set
(`src-tauri/icons-training/`, wired in `tauri.training.conf.json`), so the two
editions differ on the taskbar as well as in the window title and banner. The
1.1.0 installers and their checksums are listed in `V1.1-RELEASE-NOTES.md`.
