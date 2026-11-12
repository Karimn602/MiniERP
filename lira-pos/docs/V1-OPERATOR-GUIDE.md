# Greaz POS V1 — operator guide

For the person setting up and running the till. Backups are covered separately
in [`OPERATOR-BACKUP-RUNBOOK.md`](OPERATOR-BACKUP-RUNBOOK.md) and
[`BACKUP.md`](BACKUP.md); read those before the first day of trading.

## 1. Before installing: the Windows account

Greaz protects its data **inside the application**. It cannot protect the
database file from somebody who can sign in to Windows as the till's user —
anyone who can run programs on that account can copy or change the file. So:

1. Give the till its **own Windows account**, a standard (not administrator)
   one.
2. Give that account a **password**, and set the screen to lock when idle.
3. Turn on **BitLocker** for the drive if the edition of Windows has it.
4. Only the owner knows the Windows password of an administrator account.

## 2. Installing

Run the installer you were given (`Greaz POS_<version>_x64_en-US.msi`, or the
`-setup.exe`) **while signed in as the till's Windows account**. Check its
SHA-256 against the value in the release notes before running it.

The installer is **not code-signed**. Windows SmartScreen may warn about an
unknown publisher; that is expected for this release.

The shop's data lives in `%APPDATA%\com.greazlb.pos\greaz-pos.db` for that
Windows account. Never move, rename or delete it, or the `-wal` / `-shm` files
beside it.

## 3. First start: the owner enrolls

On first start Greaz shows **enrollment**. It needs the one-time code it wrote
to a text file in the folder above (the screen says where).

1. Choose the owner account and set a **passphrase** (a long phrase, not a PIN).
2. Greaz shows a **recovery code once**. Write it down and keep it somewhere
   safe away from the till. It is the only way back in if the owner's
   passphrase is forgotten.

## 4. Staff accounts

The owner adds staff under **Users**:

| Role | Signs in with | Can |
|---|---|---|
| Owner | passphrase | everything, including staff and costs |
| Manager | passphrase | menu, prices, stock, purchases, returns, reports, other shifts |
| Cashier | 6-digit PIN | register, own shift, driver hand-overs |

A new account must change its credential the first time it signs in.

**What a cashier cannot see.** A cashier cannot read costs, margins, cost of
goods, purchases, suppliers, recipes, stock movements, or another shift's
counted cash and variance. The Products, Sales History, Returns and Reports
screens are not offered to a cashier at all. This is enforced by the
application itself, not just hidden in the menu.

**Discounts.** A cashier may give up to **$5.00 of discount per sale** without a
manager. Anything larger — whether typed as a discount or produced by a price
lower than the menu price — needs a manager or the owner signed in. If a cashier
sees "This sale prices its lines … below the catalogue", a price was changed
while the cart was open: remove the item and add it again.

## 5. A trading day

1. **Open the shift** (Shift screen) and count the opening float.
2. Ring sales on the **Register**. Delivery orders: choose *WhatsApp / Delivery*,
   choose the driver, enter the delivery charge. The driver collects; the
   drawer does not.
3. When a driver returns with the food money, record it on **Drivers** — it
   goes into the drawer.
4. Returns are done by a **manager** on **Returns**.
5. **Close the shift**: count the drawer in dollars and in lira. Greaz shows
   what was expected and the difference.

Lock the till when you step away. It also locks itself when idle.

## 6. Only one copy at a time

Greaz runs **one copy per Windows account**. If you open it twice, the second
shows *"Greaz POS is already open"* and closes. Look for the existing window on
the taskbar.

## 7. If Greaz says it cannot start

A box titled **"Greaz POS - cannot start"** means the database did not open
correctly. Nothing is recorded while it shows.

1. Do not take payments on this till.
2. Close Greaz, make sure no other copy is running, open it again.
3. If the message returns, **write it down exactly** and call support.
4. **Do NOT delete** `greaz-pos.db`, `greaz-pos.db-wal` or `greaz-pos.db-shm`.

## 8. Closing Greaz at the end of the day

Close Greaz with the window's close button, then wait a few seconds. A clean
close folds the `-wal` file back into the database and removes both companion
files, which is what makes a backup copy safe (see the backup runbook). If
Windows is shut down or the power fails while Greaz is open, the companions
stay behind; that is safe — Greaz recovers them on the next start — but **do not
copy the database for a backup until Greaz has been opened and closed cleanly
again**.
