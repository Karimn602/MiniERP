# Greaz POS — SANDBOX (training build)

The sandbox is the **same application** as the production pilot, built from the
same commit, with the same migrations, posting commands, costing, VAT, drawer
rules and reports. It differs in exactly three things: the bundle identifier
(which decides where the database lives), the product/window name, and a
permanent on-screen warning banner.

Nothing in the sandbox changes a business rule. That is deliberate: a training
build that posted differently from production would teach the wrong habits, and
a bug found while practising would not reproduce in the real shop.

---

## 1. Identity and data location

|  | Production | Sandbox |
|---|---|---|
| Product name | `Greaz POS` | `Greaz POS SANDBOX` |
| Window title | `Greaz POS` | `Greaz POS — SANDBOX — DATA IS NOT REAL` |
| Bundle identifier | `com.greazlb.pos` | `com.greazlb.pos.sandbox` |
| Database | `%APPDATA%\com.greazlb.pos\greaz-pos.db` | `%APPDATA%\com.greazlb.pos.sandbox\greaz-pos.db` |
| Config file | `src-tauri/tauri.conf.json` | the same, overlaid with `src-tauri/tauri.sandbox.conf.json` |

### Why the identifier is the whole isolation mechanism

Both halves of the app resolve the database **relative** to the app's own
config directory, which on Windows is `%APPDATA%\<identifier>`:

- the frontend opens `sqlite:greaz-pos.db` (`src/db/client.ts`), and
  tauri-plugin-sql resolves a relative SQLite URL against `app_config_dir()`;
- the Rust posting pool resolves `app_config_dir().join("greaz-pos.db")`
  (`src-tauri/src/posting.rs::resolve_db_path`), which exists precisely so the
  two sides cannot drift onto different files.

Neither path is ever constructed from a hard-coded directory, so changing the
identifier moves **both** the migrations/reads and every transactional write
together. There is no code path that could reach the production folder from a
sandbox build: the production directory name appears nowhere in the sandbox
binary, so it is not a rule the sandbox obeys but a name it does not possess.

---

## 2. Building and running

```sh
# from lira-pos/
npm run tauri:dev:sandbox     # hot-reload sandbox desktop app
npm run tauri:build:sandbox   # packaged sandbox installer
```

Installer output:

```
src-tauri/target/release/bundle/nsis/Greaz POS SANDBOX_0.1.0_x64-setup.exe
src-tauri/target/release/bundle/msi/Greaz POS SANDBOX_0.1.0_x64_en-US.msi
```

Because the installer filename is derived from `productName`, the sandbox
installer can never overwrite the frozen production installer — the names
differ.

> The product name is `Greaz POS SANDBOX` without an em dash on purpose: the
> bundle filename is derived from it, and an em dash in an NSIS/WiX output
> filename is a needless encoding risk. The em dash appears in the *window
> title*, which is free text.

### The build-time flag

`VITE_APP_MODE` is injected by `vite.config.ts` from Vite's own `--mode`
(`vite build --mode sandbox` → `"sandbox"`, anything else → `"production"`),
and read once in `src/lib/appMode.ts`. Driving it off `--mode` rather than a
shell variable keeps the scripts identical on Windows and POSIX and keeps the
flag in version control instead of an untracked `.env` file.

It is a literal string substitution, not a runtime lookup, so in a production
build `IS_SANDBOX` folds to `false` and Rollup eliminates the banner entirely.
The production bundle does not merely skip the banner — it contains no sandbox
text, markup or title at all. (This is why the banner's wording lives inside
`SandboxBanner.tsx` rather than in `src/locales/*.ts`: a locale dictionary is a
live object read wholesale by the i18n provider, so a key there would survive
tree-shaking and ship the words "Training / Sandbox" inside the real shop's
bundle.)

The flag is permitted to control **only** the banner, the window/product
naming, and the identifier. It must never gate accounting, posting, costing,
migrations or reporting.

---

## 3. Visual differentiation

- A full-width amber hazard-striped strip reading
  **"TRAINING / SANDBOX — DATA IS NOT REAL"** (Arabic equivalent when the app
  is in Arabic), rendered above the header in `AppShell`, so it appears on every
  routed screen, and on the boot and startup-error screens too.
- It cannot be dismissed: there is no close control and no stored preference.
- It is a flex child, not a fixed overlay, so it never covers the content
  beneath it — a warning that hid the Pay button would get itself removed.
- The sidebar brand lockup reads **"Sandbox · Training"** in amber instead of
  "Retail Point of Sale".
- The window title and taskbar entry read `Greaz POS — SANDBOX — DATA IS NOT REAL`.

---

## 4. Reset procedure (sandbox only)

There is deliberately **no in-app "delete database" feature**. A destructive
button that exists in the sandbox build exists in the codebase, and the only
thing standing between it and the real shop would be a build flag.

Resetting is a manual, external act:

1. **Close the sandbox app completely.** Confirm no `Greaz POS SANDBOX.exe`
   remains in Task Manager. Deleting a database out from under an open SQLite
   connection in WAL mode can leave the app holding a deleted handle and writing
   to nothing.
2. Delete this folder and nothing else:

   ```
   %APPDATA%\com.greazlb.pos.sandbox\
   ```

   In PowerShell:

   ```powershell
   Remove-Item -Recurse -Force "$env:APPDATA\com.greazlb.pos.sandbox"
   ```

3. Relaunch the sandbox. Startup re-runs migrations 001–012 and recreates a
   fresh database with the demo rows.

**Never** pass `com.greazlb.pos` (no `.sandbox` suffix) to that command, and
never derive the path by stripping a suffix or walking up to `%APPDATA%` and
matching a prefix — `com.greazlb.pos*` matches the production folder. If a
reset script is written later it must contain the literal sandbox path and
refuse anything else, rather than accepting a directory argument.

---

## 5. Verifying isolation after a launch

Fingerprint production before launching the sandbox, and compare after:

```powershell
Get-FileHash "$env:APPDATA\com.greazlb.pos\greaz-pos.db" -Algorithm SHA256
Get-Item    "$env:APPDATA\com.greazlb.pos\greaz-pos.db*" |
  Select-Object Name, Length, LastWriteTime
```

The `.db`, `.db-wal` and `.db-shm` files must all be byte-identical and
unchanged in timestamp. Check the WAL and SHM too, not just the `.db`: a
connection that merely *opened* the production database would touch those two
first, so they are the sensitive tripwire.
