# Migrations that are written but not yet part of the schema

A file in this directory is **finished SQL that has not been applied to any
database**. It is here rather than in `../migrations/` for one specific reason:
both test harnesses treat that directory as the definition of the schema —
`src-tauri/src/lib.rs::migrations()` registers from it for sqlx, and
`tests/helpers/sqlDb.ts::migrationFiles()` globs every `*.sql` in it — so a file
sitting there is a file that runs. There is no "staged but inert" state inside
that folder.

Moving a file out of here is therefore the deliberate act of adopting it, and it
means doing the work its adoption requires in the same change.

## 024_actor_required.sql

**What it is.** `BEFORE INSERT` triggers requiring every new financial document
— sale, credit memo, purchase, supplier ledger entry, driver ledger entry,
inventory movement, shift — to name a user who exists, is active, and belongs to
that document's own store. It is the ENGINE's half of Gate 2B Stage B.2's
attribution rule: the half that holds for a writer which never goes through
`posting.rs` at all, such as a future screen, an import, a script or a support
engineer with a SQL prompt.

**Why it is not adopted yet.** Adopting it invalidates roughly 131 existing test
fixtures in one step — 166 Rust tests and 129 frontend tests failed when it was
registered. Every one of those is a fixture that inserts a sale, purchase,
movement, shift or ledger row directly and names nobody, because until Stage B.2
nobody had to be named. They are fixtures standing in for real documents, so they
must now look like real documents. The edit is mechanical, but it is 131 of them
across 19 files, and rushing it is exactly how a fixture gets quietly weakened to
make a suite pass.

**Nothing is unenforced in the meantime, and this is the part worth being precise
about.** The application already takes every actor from the authenticated session
and refuses a request naming anybody else (`authz::attribute`). That is proven
against a real database by `src-tauri/src/tests/actor_attribution.rs`, including
a structural guard that no actor column anywhere is written from a request. 024
is defence in depth against a future writer, not a fix for a present hole.

**To adopt it:**

1. Move it to `../migrations/024_actor_required.sql`.
2. Register it in `src-tauri/src/lib.rs::migrations()` as version 24,
   description `actor_required` — the commented-out block is already there.
3. Give every fixture that inserts into one of the seven tables an actor. Start
   with the shared helpers, which account for most of the failures:
   `src-tauri/src/test_support.rs` (the `inventory_movements` purchase seed and
   the `shifts` seed) and `src-tauri/src/tests/builders.rs` (the `sales` and
   `inventory_movements` inserts). Then the per-file ones, heaviest first:
   `tests/migrations.rs` (62), `tests/returns.rs` (14), `tests/drivers.rs` (11).
   The frontend side is `tests/helpers/` and the integration fixtures under
   `tests/integration/`.
4. Use the seeded owner `00000000-0000-0000-0000-000000000002` unless the test
   is about a specific person.
5. Add the upgrade tests 024 deserves and does not yet have: a populated v23
   database migrates cleanly; a historical NULL actor survives and still
   replays; a new document naming nobody, an inactive user, or another store's
   user is refused; and the one-way-door property is recorded (a pre-Stage-B
   binary cannot post against a v24 database, so rolling back needs the backup
   taken before the upgrade).

**Do not** relax a trigger to make a fixture pass. The whole value of the
migration is that it holds for writers nobody has written yet.
