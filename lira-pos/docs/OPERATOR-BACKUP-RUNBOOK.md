# Greaz POS — Backup and Recovery

**For the restaurant manager. No computer experience needed.**

Read the box below once. Everything else is a step-by-step list you can follow
while holding the phone.

> **The one rule that matters:** close Greaz POS *completely* before you copy
> anything. A copy taken while the app is open can be missing the whole
> evening's sales — and it will still open and look fine, so you will not find
> out until the day you need it. This has been tested. A copy taken from a
> running till showed **zero** of the two sales that were on the screen at the
> time.

Keep a printed copy of this document by the till. Part 10 is a form you fill in
and sign before you start trading on Greaz.

**This is the operator's document.** There is a technical companion,
`BACKUP.md`, written for whoever supports the shop. It covers the same procedure
plus the parts that need tools or judgement. If the two ever disagree,
`BACKUP.md` is correct and this file has a mistake — please report it.

---

## Part 1 — Your daily backup (2 minutes, at close of business)

Do this every trading day, after the last sale and after you close the shift.

### Step 1. Close Greaz POS completely

- Close the Greaz POS window with the **X**.
- Not minimised. Not left in the system tray. **Closed.**
- If you have a second Greaz window open somewhere, close that one too.

### Step 2. Check it is really closed

1. Press `Ctrl` + `Shift` + `Esc` together. Task Manager opens.
2. Look down the list for **Greaz POS** or **greaz-pos.exe**.
3. If you see it: click it, then click **End task**.
4. Close Task Manager.

### Step 3. Open the database folder

1. Press the `Windows` key + `R` together. A small "Run" box opens.
2. Type exactly this, then press Enter:

   ```
   %APPDATA%\com.greazlb.pos
   ```

3. A folder opens. This is where the shop's data lives.

**Careful:** if you see a folder name with anything added after `pos` — such as
`.sandbox` — that is **not** the shop's data. It is a training or test copy, and
a backup taken from it would restore a day of practice over a day of trade. The
shop's folder is exactly `com.greazlb.pos`, with nothing after it.

### Step 4. Check that the database has finished writing

Look at the files in that folder.

| What you see | What it means | What to do |
|---|---|---|
| Only `greaz-pos.db` | Good. The database is complete and safe to copy. | Go to Step 5. |
| Also `greaz-pos.db-wal` and/or `greaz-pos.db-shm` | The app did not shut down cleanly. `greaz-pos.db` on its own is **not** the whole database yet. | **STOP. Take no backup. Contact support.** See Part 6. |

**Never delete, move or rename `greaz-pos.db-wal` or `greaz-pos.db-shm` — and
do not move `greaz-pos.db` either.** A `-wal` file can hold a whole evening of
real sales. Leave all three exactly where they are; they are safe while they are
left alone.

### Step 5. Copy the database

1. Click **once** on `greaz-pos.db` to select it.
2. Press `Ctrl` + `C`.
3. Open your backup folder (USB stick or synced folder — see Part 2).
4. Press `Ctrl` + `V`.
5. Right-click the copy you just pasted → **Rename**, and name it for today:

   ```
   greaz-pos-2026-11-01.db
   ```

   Always `greaz-pos-YYYY-MM-DD.db`. Year, month, day — so the list sorts
   itself into date order.

### Step 6. Confirm the file was copied

Look at the file you just pasted and check **all four**:

- [ ] The **filename** is right: `greaz-pos-YYYY-MM-DD.db`, with today's date.
- [ ] It is in the **right place** — on the USB stick or in the synced folder,
      not left on the computer's desktop.
- [ ] The **date modified** is today.
- [ ] The **size** is roughly the same as `greaz-pos.db` (within a few percent).
      Hundreds of kilobytes or a few megabytes — **never 0 KB** — and **not
      smaller than yesterday's**. The database only grows; one that suddenly
      shrank is a warning sign. Keep it, keep yesterday's too, and report it.

A 0 KB file, a file in the wrong folder, or one noticeably smaller than
yesterday is a failed backup. Delete it, repeat from Step 1, and if it happens
twice, call support.

> ### What these checks prove — and what they do not
>
> These four checks confirm that **a file was copied to the right place**. They
> do **not** prove the backup can be restored. Those are two different claims
> and only one of them takes a minute.
>
> A database can have the right name and the right size and still be unusable.
> In testing, a copy taken the wrong way was within a few percent of the correct
> size, opened without any error, and contained **none** of the sales that were
> on the screen at the time. Damage inside a file is only found by reading the
> database, not by looking at it in Explorer.
>
> So when you tick these boxes, what you have confirmed is **"backup copied and
> checked"** — write that in the log, not "verified".
>
> **The only thing that proves a backup works is restoring it.** That is Part 8,
> and it is a separate job you do once before you start trading and again
> whenever the computer changes.

---

## Part 2 — Where backups go

**The copy must not live on the same computer.** A copy in another folder on
the same machine survives a deleted file. It does not survive a dead disk, a
theft, or a fire — and those are the reasons you are doing this.

Pick **one** of these, and use it every day:

| Option | How | Good | Watch out for |
|---|---|---|---|
| **USB stick** (recommended) | Keep it in the till drawer, plug it in at close, copy, take it home | Cheap, simple, off-site if you take it home | Useless if it lives permanently in the computer |
| **Synced folder** (OneDrive / Google Drive) | Copy into the synced folder; it uploads itself | Automatic off-site copy, nothing to carry | You must **confirm the upload finished** (green tick on the file) before shutting the PC down |
| **Second USB, weekly** | Keep a second stick off-site, swap weekly | Survives losing the daily stick | Remembering to swap |

**Best practice:** daily to a USB stick you take home, *and* a weekly copy into
a synced folder. Two different places, two different failure modes.

### Using the external drive

1. Plug the USB stick in **before** you start Step 5 above.
2. Open it: `Windows` + `E`, then click the stick in the left-hand list.
3. Make a folder on it called `Greaz-Backups` the first time.
4. Paste into that folder.
5. **Eject properly** before pulling it out: right-click the stick in the
   taskbar → **Eject**. Pulling it out mid-write can damage the backup *and*
   the stick.

---

## Part 3 — How long to keep backups

| Keep | For |
|---|---|
| Every daily backup | the last **14 days** |
| One backup per week (say every Sunday) | the last **3 months** |
| One backup per month | the last **year** |

Each file is a few megabytes, so a year of this fits on the cheapest USB stick
sold. Delete the daily files older than 14 days; keep the weeklies and
monthlies.

**Why keep old ones at all:** if something was entered wrongly three weeks ago
and nobody noticed, a backup from before the mistake is the only way to see
what the figures used to say.

---

## Part 4 — Restoring (putting a backup back)

Do this when the database is lost, damaged, or the app will not open.

> **A restore loses every sale rung up after that backup was taken.** There is
> no way to merge two databases. Read Part 7 before you start, so you know what
> you will have to re-enter.

### Step 1. Close Greaz POS and confirm it is closed

Exactly as Part 1, Steps 1 and 2.

### Step 2. Put the old database safely aside — all of it, together

1. Open `%APPDATA%\com.greazlb.pos` (Part 1, Step 3).
2. Make a new folder there. Name it `old-2026-11-01` (today's date).
3. Select **all** of these that exist, together, in one go:
   - `greaz-pos.db`
   - `greaz-pos.db-wal`
   - `greaz-pos.db-shm`
4. Drag all of them into the folder you just made — **as a group, one move.**

**Never move or delete just one of the three.** A `-wal` file separated from its
database is a chunk of real sales. A leftover `-wal` sitting next to a *restored*
database is worse: the computer would try to apply one database's notes to a
different database's data, and that is how a restore damages good data.

Moving all three together is safe and completely reversible. You are not
deleting anything — if the restore turns out to be wrong, everything is still
in that folder.

### Step 3. Copy the backup in

1. Open your backup folder and find the file you want — normally the newest,
   e.g. `greaz-pos-2026-11-01.db`.
2. Copy it (`Ctrl` + `C`).
3. Paste it into `%APPDATA%\com.greazlb.pos` (`Ctrl` + `V`).
4. **Rename it to exactly:**

   ```
   greaz-pos.db
   ```

   No date. No `(1)`. No `.db.db`. If Windows hides file extensions you may
   just need to type `greaz-pos`. Exactly that name, or the app will start with
   an empty database.

### Step 4. Start Greaz POS

It may take a little longer than usual to open the first time. That is normal
and expected: if the backup is from an older version of Greaz, the app upgrades
it on the way in. This has been tested — a backup taken before the latest
update upgraded cleanly on first open. If an upgrade ever fails, it stops and
changes nothing rather than leaving the database half-converted.

### Step 5. Verify the restore BEFORE you trade on it

Check all four, in the app:

- [ ] **Sales History** — the last few receipts are the ones you expect, with
      the right totals, for the day the backup was taken.
- [ ] **Receipt numbers** — the newest receipt number looks right. The next sale
      will carry on from there; the app will not reuse a number. This has been
      tested — a duplicate receipt number is refused by the database itself.
- [ ] **Shifts** — if a shift was open when the backup was taken, it is still
      open, and the Shift Summary shows the expected drawer figures.
- [ ] **Products** — the menu looks right, with the right prices.

If any of that looks wrong, **stop and do not trade.** Close the app, move the
restored file aside, and put the old set back from the `old-...` folder in
Step 2. Nothing is lost — that is why you kept it.

---

## Part 5 — After a computer failure

The machine will not start, or has been replaced or stolen.

1. **Do not panic and do not reinstall anything over the old disk.** If the old
   computer still powers on at all, a technician can usually copy
   `%APPDATA%\com.greazlb.pos\greaz-pos.db` straight off it — and that file is
   newer than your last backup, so it is worth trying first.
2. Install Greaz POS on the new Windows computer.
3. **Start it once and then close it.** This creates the folder the database
   goes in.
4. Follow **Part 4** to restore your newest backup.
5. Verify as in Part 4, Step 5.
6. Follow **Part 7** to re-enter anything that happened after the backup.
7. Set up the daily backup on the new machine the same evening — Part 1. A new
   machine with no backup routine is the same risk all over again.

> **Not yet proven:** restoring onto a genuinely different physical computer has
> **not** been tested for Greaz. The testing behind this runbook restored into a
> separate, clean Greaz installation on **one** machine, and it passed
> completely. The backup is a single self-contained file holding nothing
> specific to a particular computer, so there is no technical reason this should
> fail — but "no reason to fail" is not the same as "tested". **Do the rehearsal
> in Part 8 on a second computer before you start trading on Greaz.**

---

## Part 6 — The extra files are still there after closing

You closed the app, but `greaz-pos.db-wal` and/or `greaz-pos.db-shm` are still
in the folder.

**Nothing is broken and nothing is lost.** It means the app did not get to
finish tidying up — it was killed, it crashed, or the computer was switched off
at the wall. The sales in that `-wal` file are safe; the app puts them back
automatically the next time it opens. This has been tested: a sale left in a
`-wal` by an unexpected shutdown was still there on reopening, and the database
was not damaged.

The only problem it causes is the one Part 1 Step 4 is about — `greaz-pos.db` on
its own is not yet the whole database, so copying it now would give you an
incomplete backup.

### What to do: STOP and call support

1. **Do not take a backup tonight.** A copy taken now would be missing sales.
2. **Do not delete, move or rename any of the three files** — not
   `greaz-pos.db-wal`, not `greaz-pos.db-shm`, and not `greaz-pos.db`. A `-wal`
   file can hold a whole evening of real sales, so deleting one throws away real
   money, and separating them is how a database gets damaged by hand.

   *(Part 4, Step 2 does ask you to move all three — but that is a restore, when
   you have already decided to go back to a backup, and they move together as a
   group. Right now you are trying to back up data you are still using, so touch
   nothing.)*
3. **Leave everything exactly where it is** and contact whoever supports the
   shop. Tell them: *"Greaz is closed but the `-wal` and `-shm` files are still
   in the folder."* That one sentence is all they need.
4. **You can keep trading normally.** The till is not at risk — only tonight's
   backup is. Greaz will sort the files out itself next time it opens.

**Why you are not asked to fix this yourself:** the fix depends on *why* the
files are there, and the wrong guess puts a whole evening's sales at risk. It is
a two-minute job for support and it is written down for them in `BACKUP.md`.
Getting a backup one day late is a small problem; deleting a `-wal` file is not.

---

## Part 7 — Sales made after the last backup

A restore puts you back to the moment the backup was taken. Anything rung up
after that is not in it. There is no merge — never try to combine two
databases.

**What to do:**

1. **Work out the gap.** The backup's filename gives you the date. Your last
   receipt in the restored Sales History gives you the last sale it knows
   about.
2. **Gather the paper.** Printed customer receipts, kitchen tickets, the
   WhatsApp order history for deliveries, and the cash actually in the drawer.
3. **Re-enter the sales** through the normal register, as if they were
   happening now.
4. **Accept that the receipt numbers will differ.** The re-entered sales get
   new numbers, so the customer's printed receipt #412 may be #405 in the
   system. Write the original number in the kitchen-note field so the two can
   be matched later. This is a reconciliation note, not a problem with the
   data.
5. **Reconcile the drawer last.** Count the physical cash, compare it against
   the shift summary after re-entry, and record the difference as the shift
   variance. Do not adjust sales to make the cash match — the variance is the
   honest record of the gap.
6. **Write it down.** One sheet: the date, what was lost, what was re-entered,
   and what the variance came to. In a month nobody will remember.

**This is the real cost of a restore, and it is why the daily backup matters.**
A backup taken at close of business means you can lose at most one day — and
usually much less, because the failure normally happens overnight.

---

## Part 8 — Rehearse it once, before you need it

**A backup is not proven until it has been restored.** Do this once, calmly,
before you start trading on Greaz — and then once more whenever the computer is
replaced.

1. Take a normal backup (Part 1).
2. On a **second** computer, install Greaz POS, start it once, close it.
3. Restore your backup onto it (Part 4).
4. Check that the last day's receipts, the drawer figures and the open shift are
   all there (Part 4, Step 5). You do this in Greaz's own screens — no extra
   tools are needed.
5. Delete the test database from the second machine afterwards, so nobody
   trades on it by mistake.
6. Record the result in Part 10 and sign it.

Twenty minutes, once. The alternative is finding out it does not work on the one
morning the answer cannot be "it didn't".

---

## Part 9 — Known limits (please read before you start trading)

Honest list of what this procedure does **not** cover today.

1. **The backup is manual.** Nothing reminds you and nothing checks it
   happened. If nobody does Part 1 on a given evening, there is no backup for
   that day and nothing will say so. Greaz has no automatic backup on purpose —
   an automatic backup nobody verifies is worse than a routine somebody
   performs, because it is trusted. The trade-off is that this routine depends
   entirely on a person, which is why Part 10 asks for a name.
2. **Restoring to a different physical computer is untested.** See Part 5.
3. **There is no way for you to back up without closing the app, and there is
   not meant to be.** Snapshotting the database while the till keeps trading is
   possible, but it needs a separate program that is **not included with
   Greaz**. It is a task for a technician, not a routine step for a manager.
   **The only backup procedure you perform is Part 1, with the app closed** —
   and that one is fully tested.
4. **Checking a backup is not the same as verifying it.** The four checks in
   Part 1, Step 6 confirm a file was copied to the right place. They cannot
   prove the inside of the file is sound. Only an actual restore proves a backup
   works, which is why Part 8 exists as its own job.
5. **There is one terminal and no cloud sync.** By design, the shop's data
   exists in exactly one place until you copy it. Where that copy goes, and who
   checks it, is the single biggest decision in this document — which is why
   Part 10 asks you to write both down before you start trading.

---

## Part 10 — The backup record (fill this in before you start trading)

**This document is not finished until this section is.** Nothing in Greaz
reminds anybody to take a backup and nothing notices when one stops happening,
so the only thing standing between the shop and a silent gap is a named person
and a named place. Print this, fill it in, sign it, and keep it by the till.

### Backup location

| | |
|---|---|
| Primary destination (device + folder) | ............................................ |
| Example | `USB stick "GREAZ-BACKUP"` → `\Greaz-Backups\` |
| Where the device is kept overnight | ............................................ |
| Secondary / weekly destination | ............................................ |
| Off-site? (the primary must leave the building) | Yes ☐  No ☐ |

A destination that never leaves the shop is not a backup location — see Part 2.

### Responsible person

| | |
|---|---|
| Person responsible for the daily backup | ............................................ |
| Deputy, for their days off | ............................................ |
| Who to contact if a backup fails | ............................................ |
| Support contact (name + number) | ............................................ |

One named person, not "whoever closes up". A rota with no name on it is how
three weeks pass with no backup.

### Daily backup verification

Tick the box each evening after Part 1, Step 6. **"Checked" means the file was
copied to the right place** — it does not mean the backup has been proven
restorable (see Part 1, Step 6 and Part 8).

| Date | Filename | Size OK | On the external device | Initials |
|---|---|---|---|---|
|  |  | ☐ | ☐ |  |
|  |  | ☐ | ☐ |  |
|  |  | ☐ | ☐ |  |
|  |  | ☐ | ☐ |  |
|  |  | ☐ | ☐ |  |
|  |  | ☐ | ☐ |  |
|  |  | ☐ | ☐ |  |

A missed evening is written in as **MISSED**, not left blank. A blank row is
unreadable six weeks later; "MISSED" is information.

### Retention schedule

| Keep | For | Who prunes, and when |
|---|---|---|
| Every daily backup | 14 days | ...................... |
| One per week (e.g. Sunday) | 3 months | ...................... |
| One per month | 1 year | ...................... |

### Recovery steps — where they are

| Situation | Go to |
|---|---|
| Database lost or damaged, app will not open | **Part 4 — Restoring** |
| Computer dead, replaced or stolen | **Part 5 — After a computer failure** |
| `-wal` / `-shm` still there after closing | **Part 6 — STOP and call support** |
| Sales made after the last backup | **Part 7 — Reconciling the gap** |

Do not improvise a recovery. Every situation above has a written procedure, and
the written one keeps the old data recoverable while you work.

### Second-computer restore — NOT YET TESTED

| | |
|---|---|
| Status | **NOT TESTED. This is the one outstanding *test*** — the other outstanding item is this form itself, which needs a named backup owner above and a signature below. |
| What was tested | A restore into a second clean Greaz installation on **one** computer. It passed completely. |
| What was *not* tested | A restore onto a genuinely different physical computer. |
| Why it probably works | The backup is one self-contained file holding nothing specific to a computer. |
| Why that is not enough | "No reason to fail" is an argument, not a test. |
| **Until this is signed off** | **Nobody may state that Greaz recovers from the loss of the computer.** |

Rehearse it per Part 8, then sign:

| | |
|---|---|
| Rehearsed on (date) | ...................... |
| Second machine used | ...................... |
| Backup file restored | ...................... |
| Receipts, drawer figures and open shift all present | Yes ☐  No ☐ |
| Test database deleted from the second machine afterwards | Yes ☐  No ☐ |
| Signed | ...................... |

---

## How this document reaches the shop

This file is **not** delivered by the installer on its own. Tauri's bundler ships
the application and the resources its configuration lists; it does **not**
automatically include anything from the `docs/` folder, and nothing in
`tauri.conf.json` references this file today. Assuming otherwise is how a pilot
arrives with no runbook.

So delivering it is a deliberate step. In order of preference:

1. **Printed and signed, handed over at installation.** Parts 1–7 are meant to
   be read while standing at the till, and Part 10 is a form that has to be
   filled in and signed before trading starts. A printed copy in a folder by the
   till is the primary delivery, and it is the only one that works when the
   computer is the thing that has failed — which is exactly when Parts 4, 5 and
   6 are needed.
2. **A PDF on the backup USB stick**, so it travels with the backups and is
   readable from any other machine.
3. **Alongside the installer**, as a file in the same folder or archive the
   pilot is delivered in, so whoever installs Greaz has it in hand.
4. **Optionally bundled into the installer later.** If the runbook should ship
   inside the application, that is a build-configuration change — adding it to
   the bundle resources in `tauri.conf.json` and giving the app a way to open
   it. That work has **not** been done and is not assumed anywhere here.

**Whichever route is used, Part 10 must be completed and signed on paper before
the shop trades on Greaz.** An unsigned Part 10 means no named backup owner and
no tested restore, and those are the two open items.
