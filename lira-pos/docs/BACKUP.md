# Greaz POS — database location and backup policy

Scope: one small restaurant, one terminal, cash only. This is the whole policy,
deliberately. WP-07 assessed automatic backup and did not build one — see
*Why there is no automatic backup* at the end.

## Where the database is

One file, named in one place:

| | |
|---|---|
| File name | `greaz-pos.db` (`posting.rs::PRODUCTION_DB_FILENAME`) |
| Directory | the Tauri **app config dir** for the bundle identifier |
| On Windows | `%APPDATA%\<bundle-identifier>\greaz-pos.db` — e.g. `C:\Users\<user>\AppData\Roaming\com.greaz.pos\greaz-pos.db` |

Both halves of the application resolve that one path:

* the JavaScript side opens `sqlite:greaz-pos.db` through tauri-plugin-sql,
  which resolves a relative SQLite URL against `app_config_dir()`;
* the Rust posting commands join `PRODUCTION_DB_FILENAME` onto
  `app_config_dir()` for the same reason (`posting.rs::resolve_db_path`).

Until WP-07 the Rust side used `app_data_dir()`. On Windows that is the same
folder, so the pilot never saw a problem; on macOS and Linux it is a different
one, and the app would have split in half — migrations and reads in one
database, every posting command writing to another. Fixed, and worth
remembering if Greaz is ever packaged for anything but Windows.

To find the exact folder on a running install: open the app, then look for the
most recently modified `greaz-pos.db` under `%APPDATA%`.

## Companion files

The application runs SQLite in **WAL** mode (`db/migrate.ts::ensureDbReady`
issues `PRAGMA journal_mode = WAL`, which is persisted in the database header).
While the app is running you will therefore also see:

* `greaz-pos.db-wal` — committed transactions not yet folded into the main file
* `greaz-pos.db-shm` — shared-memory index for the WAL

**These are part of the live database, not scratch files.** That is why the
procedure below has exactly one step that matters more than the others: the
app must be CLOSED before you copy anything.

## Backing up — the one supported procedure

1. **Close Greaz POS completely.** Not minimised, not left in the tray —
   closed.
2. **Confirm it is no longer running.** On Windows, open Task Manager and check
   there is no Greaz POS (or `greaz-pos.exe`) process. A second window you
   forgot about is still writing to the database.
3. **Confirm SQLite has finished.** In the app config folder, check that
   `greaz-pos.db-wal` and `greaz-pos.db-shm` are **gone**. SQLite checkpoints
   the WAL into the main file and deletes both on a clean shutdown, so their
   absence is the signal that `greaz-pos.db` is complete and self-contained.
   If they are still there, see *If the WAL files will not go away* below.
4. **Copy `greaz-pos.db`** out of the app config folder (the path in the table
   above). That single file is the whole database.
5. **Keep timestamped copies, externally.** Name each one for the day —
   `greaz-pos-2026-10-05.db` — and keep them somewhere that is not the same
   machine: a USB stick, or a synced folder. Retain the last several days.
   "Externally" is the part that matters: a copy beside the original survives a
   deleted file but not a dead disk.
6. **Restore only while the app is closed** (see below).
7. **Restore to the exact canonical path**, with the exact name
   `greaz-pos.db`.
8. **Start the app and check it.** Open Sales History and Shift Summary and
   confirm the recent figures look like the day you backed up. That ten-second
   check is the only thing that distinguishes a backup from a file.

Do this once at close of business. The database is a few megabytes, so a week
of daily copies costs almost nothing.

### Do not copy the database while the app is running

There is no supported live-copy procedure, and in particular **do not copy
`greaz-pos.db`, `-wal` and `-shm` one after another while the app is open.**
Each file is read at a different instant, and the WAL moves between them, so the
set you end up with can represent no state the database was ever in. It will
usually still open, which is what makes it dangerous: you find out it was
unusable on the day you need it.

If a backup is genuinely needed without closing the app, the correct tool is
SQLite's own online backup (`sqlite3 greaz-pos.db ".backup out.db"`), which
takes a consistent snapshot. WP-07 did not build that in, because for a shop
that closes every night there is nothing it buys.

### If the WAL files will not go away

`greaz-pos.db-wal` and `greaz-pos.db-shm` remaining after shutdown means the
app did not exit cleanly — it was killed, or it crashed, or a process is still
holding the file.

Safe action, in order:

1. Make sure no Greaz POS process is running (Task Manager).
2. Start the app and close it again, normally. A clean shutdown checkpoints the
   WAL and removes both files. **This is the fix** — SQLite does the merge
   itself, correctly.
3. Re-check that both files are gone, then take the backup.

Do **not** delete a `-wal` file by hand: it can hold committed transactions that
are not yet in the main file, and deleting it discards them — potentially a
whole evening's sales. And do not copy a `.db` whose `-wal` is still present,
for the same reason: the copy is an older database than the one you are looking
at.

## Restoring

1. Close Greaz POS and confirm no process is running.
2. In the app config folder, move aside `greaz-pos.db` **and** any `-wal` /
   `-shm` files. Leaving a stale `-wal` beside a restored `.db` is how a restore
   corrupts: SQLite would try to replay one database's WAL onto another's data.
3. Copy the backup in, renamed to exactly `greaz-pos.db`. Nothing else.
4. Start the app. It will run any migrations the backup has not seen, which is
   expected and safe — a failing migration rolls back and leaves the schema
   untouched (`hardening.rs::a_failing_migration_rolls_back_and_leaves_the_schema_untouched`).
5. Verify as in step 8 above before trading on it.

A restore loses everything rung up after the backup was taken. There is no
merge: never try to combine two databases.

## Why there is no automatic backup

WP-07 assessed it and judged it not worth building for this pilot:

* The failure it would protect against — a disk or file loss between two manual
  copies — is covered by a daily close-of-business copy, which someone is
  already present to do.
* An automatic copy taken while the app is running has to handle the WAL
  correctly, which means either a checkpoint or SQLite's backup API, plus
  retention, plus a place to put it, plus something that notices when it stops
  working. A backup nobody verifies is worse than a routine somebody performs,
  because it is trusted.
* Greaz has one terminal and no cloud sync, so there is no second copy of the
  data anywhere by design. That is the real risk, and it is a deployment
  decision (where the daily copy goes, and who checks it) rather than a code
  one.

If the pilot shows the daily copy is not actually happening, the cheapest fix is
a checkpoint-and-copy on application exit, not a background scheduler.

## What the database guarantees on its own

Worth knowing when judging how much backup paranoia is warranted:

* **Every financial write is one transaction.** A sale, a purchase, a supplier
  payment, a shift close, an inventory adjustment and a credit memo each commit
  or roll back whole, including the number sequence they consume. A crash
  mid-command leaves nothing behind — not a header without children, not stock
  without its document, not a consumed receipt number.
* **Posted documents are immutable**, enforced by the engine rather than by the
  application, so a corrupted or malicious write cannot quietly restate
  history — it is refused.
* **WAL plus the default `synchronous = FULL`** means a committed transaction
  survives a power cut. What is lost in a crash is at most the transaction in
  flight, which was never committed and never shown as complete.
