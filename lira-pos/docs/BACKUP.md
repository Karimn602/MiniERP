# Greaz POS — database location and backup policy

Scope: one small restaurant, one terminal, cash only. This is the whole policy,
deliberately. WP-07 assessed automatic backup and did not build one — see
*Why there is no automatic backup* at the end.

**Two audiences, and the split matters.** There is exactly ONE backup procedure
for a restaurant operator — *The one supported backup procedure (closed
database)* — and it needs nothing but Windows. Everything under *For support
personnel only* requires tools Greaz does not ship, or judgement about why the
machine is in the state it is in, and must not be handed to a manager as a
routine step. The operator's step-by-step version, with keystrokes and the
sign-off record the pilot requires, is **`docs/OPERATOR-BACKUP-RUNBOOK.md`** —
tracked, release-intended, and the document that is printed and handed to the
shop. See *How this document reaches the shop* at the end of it: the installer
does not deliver it on its own.

Qualified by the Gate 1 backup rehearsal, verdict **CONDITIONAL PASS**. The two
unmet conditions are unchanged and are both sign-offs rather than engineering:
**a restore onto a second physical computer has not been tested** (stated under
*Rehearse it once* below, and in the runbook's Part 10), and **no named backup
owner has been recorded** (the runbook's Part 10 exists for exactly that, and
is not complete until it is filled in and signed).

## Where the database is

One file, named in one place:

| | |
|---|---|
| File name | `greaz-pos.db` (`posting.rs::PRODUCTION_DB_FILENAME`) |
| Directory | the Tauri **app config dir** for the bundle identifier |
| On Windows | `%APPDATA%\<bundle-identifier>\greaz-pos.db` |
| The shop's database | `C:\Users\<user>\AppData\Roaming\com.greazlb.pos\greaz-pos.db` |
| The training build's | `C:\Users\<user>\AppData\Roaming\com.greazlb.pos.sandbox\greaz-pos.db` |

The two are different files in different folders, and the only thing separating
them is the bundle identifier. **Back up the first one.** The sandbox exists so
that training never touches the shop's figures; a backup taken from it would
restore a day of practice over a day of trade.

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

The application runs SQLite in **WAL** mode. It is set during Rust startup by
`src-tauri/src/db_init.rs` and persisted in the database header, and since the
startup-hardening correction Greaz **refuses to trade** if it cannot confirm it
— see *What the database guarantees on its own*. Until Gate 2A the statement
came from the frontend (`db/migrate.ts::ensureDbReady`); it does not any more,
and that module no longer issues PRAGMAs at all.

While the app is running you will therefore also see:

* `greaz-pos.db-wal` — committed transactions not yet folded into the main file
* `greaz-pos.db-shm` — shared-memory index for the WAL

**These are part of the live database, not scratch files.** That is why the
procedure below has exactly one step that matters more than the others: the
app must be CLOSED before you copy anything.

Closing the app is what folds the WAL back into `greaz-pos.db` and removes both
companions. SQLite does that when the LAST connection to the file closes, so it
only works if the application actually closes every connection it opened — and
until the lifecycle correction (see *What the database guarantees on its own*)
Greaz did not. Its posting pool was left open, the merge never ran, and a till
closed straight after a sale kept its `-wal` as if it had crashed. If you are
running a build from before that correction, treat step 3 below as unreliable
and expect the companions to still be there.

## The one supported backup procedure (closed database)

**This is the only backup procedure a restaurant operator should perform.**
There is exactly one, it requires no tools beyond Windows itself, and it is the
procedure qualified by the Gate 1 rehearsal. Anything else on this page is for
support personnel.

The step-by-step version for a manager, with the exact Windows keystrokes, is
`docs/OPERATOR-BACKUP-RUNBOOK.md`. This section is the authoritative summary;
where the two differ, this page is correct.

1. **Close Greaz POS completely.** Not minimised, not left in the tray —
   closed, with the window gone.
2. **Confirm the process has exited.** Open Task Manager
   (`Ctrl`+`Shift`+`Esc`) and confirm there is no **Greaz POS** or
   `greaz-pos.exe` process. A second window somebody forgot about is still
   writing to the database.
3. **Confirm the WAL companions are absent.** In the app config folder, check
   that `greaz-pos.db-wal` and `greaz-pos.db-shm` are **both gone**. SQLite
   checkpoints the WAL into the main file and deletes both on a clean shutdown,
   so their absence is the signal that `greaz-pos.db` is complete and
   self-contained. **If either is still there, STOP — do not copy anything.**
   See *If the WAL companions remain after closing* below.
4. **Copy `greaz-pos.db` to external storage.** That single file is the whole
   database. Copy it to a USB stick or a synced folder — somewhere that is
   **not this machine**. A copy beside the original survives a deleted file but
   not a dead disk, a theft or a fire, and those are the reasons for doing this.
5. **Verify the filename, the size and the destination.** The copy must be
   named for the day — `greaz-pos-2026-10-05.db`, always `YYYY-MM-DD` so the
   list sorts into date order — it must be on the external destination you
   intended, its size must be within a few percent of `greaz-pos.db`, and it
   must never be 0 KB or smaller than yesterday's. Read the next section before
   trusting what this step proves.
6. **Preserve the historical copies.** Do not overwrite yesterday's. Keep every
   daily copy for 14 days, one per week for 3 months, one per month for a year.
   A year of this fits on the cheapest USB stick sold, and a backup from before
   a mistake nobody noticed is the only way to see what the figures used to say.
7. **Restore and inspect it on an isolated installation, once.** A backup is
   not qualified until it has been restored — see *Rehearse it once* below.

Do this once at close of business, after the shift is closed.

### What step 5 proves, and what it does not

Checking the filename, the size and the destination confirms that **a file was
copied to the right place**. It does not confirm that the file can be restored.

These are different claims and only one of them is cheap. A database can be the
right name and the right size and still be unusable: the Gate 1 rehearsal
produced a copy that was within a few percent of the correct size, opened
without complaint, and contained **none** of the posted sales — and a corrupted
or truncated file is only detected by reading the database itself, not by
looking at its directory entry.

So:

* **Step 5 is a daily smoke check.** It catches the backup that plainly failed —
  a 0 KB file, a copy that went to the wrong folder, a stick that was not
  plugged in. That is worth doing every day, and it is all an operator can do
  in a minute.
* **Only an actual restore proves a backup is restorable.** That is step 7, and
  it is why it exists as its own step rather than a footnote.

Never record "backup verified" on the strength of a filename and a size. The
honest wording is "backup copied and checked"; "verified" belongs to the day
somebody restored one.

### NEVER copy the database while Greaz POS is running

**Prohibited. There is no supported live-copy procedure for an operator.**

Do not copy `greaz-pos.db` while the application is open, and in particular do
not copy `greaz-pos.db`, `-wal` and `-shm` one after another. Each file is read
at a different instant and the WAL moves between them, so the set can represent
no state the database was ever in.

**This silently loses posted transactions.** The Gate 1 rehearsal copied
`greaz-pos.db` from a running till holding two posted sales — one of them a
recipe-costed sale with its frozen cost evidence — and the copy contained
**0 of the 2 sales and 0 of the 2 evidence rows**. One sale was present in the
copy as an unposted *draft*, a state the application had already reported as
posted and printed a receipt for. The copy opened cleanly, passed
`PRAGMA integrity_check`, and looked like a slightly older database. **Nothing
warned.** That is what makes it dangerous rather than merely wrong: you find
out on the day you need it.

The same loss is demonstrated in the automated suite —
`lifecycle.rs::copying_only_the_main_file_while_the_wal_is_live_loses_the_sale`
— and reproduced operationally by the Gate 1 backup rehearsal (an internal
qualification artefact under `lira-pos/dev/`, not part of the release).

If a backup is genuinely needed without closing the till, that is a technician
task and needs a tool Greaz does not ship. See *Optional: live snapshot (support
personnel only)*.

### If the WAL companions remain after closing

`greaz-pos.db-wal` or `greaz-pos.db-shm` still present after the application has
closed means it did not exit cleanly — it was killed, it crashed, the machine
was switched off at the wall, or a process is still holding the file.

**It does not mean the database is damaged.** A WAL left behind holds committed
transactions that SQLite replays automatically and correctly the next time the
database is opened; nothing is lost and nothing is corrupt. Gate 1 confirmed
this operationally: a committed sale left in an abandoned `-wal` survived
reopening and the database passed `PRAGMA integrity_check`.

The only problem it causes is the one this page is about — `greaz-pos.db` on its
own is not the whole database yet, so a copy of it would be incomplete.

**Operator action: STOP and contact support.**

1. **Do not take a backup.** A copy taken now would be missing transactions.
2. **Do not delete, move or rename `greaz-pos.db-wal` or `greaz-pos.db-shm`,
   and do not delete, move or rename `greaz-pos.db` either.** A `-wal` can hold
   committed sales that are not yet in the main file, so deleting one discards
   real money — potentially a whole evening's trade — and separating the files
   is how a database gets damaged by hand.

   *This is not a contradiction of* Restoring *step 2, which does move all three
   files together into a dated folder.* That is a deliberate recovery: the
   decision to go back to a backup has already been made, and the set is moved
   **as a group** so it stays intact and reversible. Here you are trying to take
   a backup of data you intend to keep using — so change nothing at all.
3. **Leave all three files exactly where they are** and contact whoever supports
   the shop. The data is safe while it is left alone.
4. Greaz can keep trading in the meantime. The next time the app opens, SQLite
   replays the WAL itself; the till is not at risk, only tonight's backup is.

The remedy is a one-line SQLite operation, but it requires judgement about *why*
the companions are there, so it belongs to support: see *If the WAL companions
remain — remedy* under the support section.

## Restoring

1. Close Greaz POS and confirm no process is running.
2. Set the OLD database aside — **the whole set, together, in one move.** Make a
   dated folder next to it and move `greaz-pos.db` and any `-wal` / `-shm` into
   it as a group. Never delete one of the three and never move one without the
   others: a `-wal` separated from its database is a chunk of real sales, and a
   stale `-wal` left beside a restored `.db` is how a restore corrupts, because
   SQLite would try to replay one database's log onto another's data. Moving all
   three together is safe, reversible, and asks nobody to judge which file
   matters.
3. Copy the backup in, renamed to exactly `greaz-pos.db`. Nothing else.
4. Start the app. It will run any migrations the backup has not seen, which is
   expected and safe — a failing migration rolls back and leaves the schema
   untouched (`hardening.rs::a_failing_migration_rolls_back_and_leaves_the_schema_untouched`).
   Gate 1 confirmed this operationally: a backup predating migration 022
   upgraded forward cleanly on first open.
5. **Inspect it in the application before trading on it.** Open Sales History
   and confirm the recent receipts and totals are the day you backed up; check
   that the newest receipt number looks right; open Shift Summary (or Shift
   History) and confirm the drawer figures and any open shift; check Products
   for the right menu and prices. If anything looks wrong, close the app, move
   the restored file aside and put the old set back from the folder in step 2 —
   nothing has been lost, which is why that folder exists.

A restore loses everything rung up after the backup was taken. There is no
merge: never try to combine two databases.

### Rehearse it once, before you need it

**A backup is not qualified until it has been restored**, and a restore is the
only thing that proves it (see *What step 5 proves, and what it does not*).

Do it on an **isolated installation** — a spare Windows computer with Greaz
installed, started once and closed so the folder exists. Restore a recent
backup onto that machine following *Restoring* below, then confirm in the
application itself that the last day's receipts, both drawer figures and the
open shift are all there. The check is made through Greaz's own screens, which
needs no extra tools; it does not require `sqlite3` and must not be made
dependent on it.

Delete the test database from the spare machine afterwards, so nobody trades on
it by mistake.

Doing that once, calmly, is what tells you the routine works; the alternative is
finding out during an emergency, which is the one moment the answer cannot be
"it didn't".

Two different things have now been rehearsed, and they are not
interchangeable:

* `lifecycle.rs::a_restored_backup_preserves_sales_payment_legs_movements_and_counters`
  rehearses it in the test suite — take a backup, restore it, and check that the
  sale, both payment legs, the inventory movement and the receipt-number
  sequence all survive, and that the restored database carries on numbering from
  where it left off rather than colliding.
* The Gate 1 rehearsal exercised it operationally against WP-B2-B data (record
  under `lira-pos/dev/`, internal, not part of the release): a published
  recipe, a recipe-costed
  posted sale with its frozen `sale_item_recipe_costs` evidence, a kitchen note,
  split USD/LBP tender, an open shift and live inventory all survived
  close → copy → restore byte-for-byte, the restored database passed
  `integrity_check` and `foreign_key_check`, trade resumed at the next receipt
  number, and a duplicate receipt number was refused by the engine.

**Neither covers a second physical computer.** Gate 1 restored into a second
clean application identity on **one** machine. The database file is
self-contained and holds no machine-specific data, so there is no technical
reason a cross-machine restore should fail — but that is an argument, not a
test. **OFF-MACHINE RESTORE IS UNVERIFIED**, and nobody should state that Greaz
recovers from machine loss until the rehearsal above has been done on a
genuinely separate computer.

## For support personnel only

Everything in this section needs tools Greaz does not ship, or judgement about
*why* something is in the state it is in. **None of it is part of the operator
procedure, and none of it should be given to a restaurant manager as a routine
step.** The operator procedure is the closed-database copy above, and it is
complete on its own.

### Optional: live snapshot (requires separately installed tools)

> **Not an application feature.** Greaz does **not** include, bundle, install or
> expose this. It is an optional procedure for a technician who has separately
> installed the SQLite command-line tool on the machine.

**Prerequisite:** `sqlite3.exe`, obtained from <https://sqlite.org/download.html>
and placed on `PATH`. It is **not shipped with Greaz and is not present on a
default Greaz machine** — Gate 1 confirmed it absent on the pilot machine. If
`sqlite3 --version` does not answer, this procedure is unavailable and the
closed-database copy is the only option.

With the tool installed, SQLite's own snapshot takes a consistent copy while the
till keeps trading:

```
sqlite3 greaz-pos.db "VACUUM INTO 'greaz-pos-2026-10-11.db'"
```

That produces one self-contained file with every committed transaction in it,
WAL included. Verified two ways: in the suite by
`lifecycle.rs::vacuum_into_snapshots_a_live_database_including_wal_commits`, and
operationally by the Gate 1 live-snapshot probe (internal, under
`lira-pos/dev/`), which snapshotted
a live database holding a sale that existed **only** in the WAL plus a
recipe-costed sale's frozen evidence, and got back one file with `integrity ok`,
no foreign-key violations, the WAL-only sale present and no companion files.

It is deliberately **not** wired into the application, for the same reason there
is no automatic backup: a backup nobody verifies is worse than a routine
somebody performs, because it is trusted.

Note the asymmetry, because it is the whole point of the prohibition above: a
plain **file copy** of a running database silently loses transactions, while
`VACUUM INTO` against the same running database does not. The difference is that
SQLite is doing the reading in the second case. It is not a reason to relax the
operator rule — it is a reason the operator rule says "closed".

### If the WAL companions remain — remedy

When an operator reports that `greaz-pos.db-wal` / `-shm` survived a clean
close, establish *why* before doing anything: a crash and a still-running
process are different problems, and a process still holding the file will simply
recreate the companions.

1. Confirm no `greaz-pos.exe` is running (Task Manager, or `tasklist`).
2. If one is, end it, and find out what started it — a second window, a stuck
   process, or an installer.
3. **Start Greaz and close it again, normally.** A clean shutdown checkpoints
   the WAL into the main file and removes both companions; SQLite performs the
   merge itself, correctly, and this is the remedy. `close_db_pool_on_exit`
   closing the posting pool on `RunEvent::Exit` is what makes it work — a build
   predating that correction leaves the WAL behind even on a clean close.
4. Re-check that both companions are gone, then take the backup.
5. If they survive a reboot and a clean open/close cycle, treat it as a disk or
   permissions fault on that folder and stop touching the files.

**Never delete, move or rename a `-wal` file**, and never separate the three
files. A `-wal` holds committed transactions that are not yet in the main file.

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
* **Closing the app closes the database.** Greaz holds three connection pools
  against the one file — tauri-plugin-sql's, the posting pool in `posting.rs`
  that every financial command uses, and (since Gate 2A) the read-only pool
  behind the renderer's `db_select`. The plugin always closed its own on exit;
  nothing closed the posting pool, so the WAL was never merged and the step-3
  check above could not be trusted. `lib.rs` now closes both of the others on
  `RunEvent::Exit`, and in a specific ORDER: the read-only pool first, because
  only a connection that may WRITE can perform SQLite's final checkpoint, so a
  read-only handle closing last would leave the companions on disk exactly as
  if nothing had been closed at all. It changes no durability setting: WAL,
  `synchronous`, foreign keys and every posting guard are exactly as they were.

* **Greaz will not trade on a database it has not validated.** On startup it
  proves two things before anything can be read or written: that every
  migration this build needs is applied and recorded as successful, and that
  the journal mode really is `wal` — read back on a second connection that did
  not set it, so the answer comes from the file rather than from one session.
  If either check fails, the window still opens but every sale, refund, shift,
  catalog change and administrative write is refused, the screen says what is
  wrong and what to do, and nothing is recorded. There is deliberately no
  fallback to another journal mode: a database that trades perfectly and
  silently cannot be backed up by the procedure above is the worse outcome, not
  the safer one.

  This matters for step 3 specifically. The absence of `-wal` and `-shm` only
  means "the main file is complete" if the database was in WAL in the first
  place; in SQLite's default `delete` mode those files never appear at all, so
  the check would pass every time while proving nothing. Before the hardening
  correction a build that failed to establish WAL logged a line and opened the
  till anyway. It now refuses, which is what makes step 3 trustworthy rather
  than merely usual.
