# Greaz POS V1 — release candidate notes

| | |
|---|---|
| Source commit | `1a6aa9b8f0d0e181ad5a7eadd6a8e0c45e2538c1` (branch `sandbox/greaz-training`) |
| Version | 0.1.0 |
| Built | 2026-11-12T23:19Z, `npm run tauri build`, production configuration (`com.greazlb.pos`) |
| Code signing | **NONE.** No signing process was run. SmartScreen will warn. |

## Installers

| File | Bytes | SHA-256 |
|---|---|---|
| `Greaz POS_0.1.0_x64_en-US.msi` | 5,951,488 | `a7b4c46abdefb7fc946eb9a7d9d42c6df966098146062aa9d16549980da240cd` |
| `Greaz POS_0.1.0_x64-setup.exe` | 4,119,633 | `6202177fb0db8c3891e769c815d2fb88a29a01c13a4f3af0788a5702d66a4020` |

Verify before installing (PowerShell): `Get-FileHash '<file>' -Algorithm SHA256`.

**Do not use any other installer in `src-tauri/target/release/bundle/`.** That
folder also holds October builds (`Greaz POS RC1_…`, `Greaz POS WP6_…`,
`Greaz POS SANDBOX_…`) that predate staff accounts, authorization and every fix
below, and acceptance builds (`Greaz POS V1RC Acceptance…`) that use a test
identity. Only the two files above, with those hashes, are this release.

These installers were **built but not installed or run on the build machine**:
the production identity's database there is protected data. Packaged behaviour
was proven with byte-for-byte the same source built under a disposable
identifier (only `identifier`, `productName` and the window title differ).

## What changed since the last candidate

* **Discount control binds the real discount** (GZ-B-P1). A cashier can no
  longer give more than $5.00 off by sending a lower price or a lower line total
  instead of a declared discount. Price differences are treated as discount, so
  a cart rung before a reprice still works within the limit.
* **Cashiers cannot read confidential figures** (Stage C). Costs, margins, cost
  of goods, purchasing, suppliers, recipes, stock movements and other shifts'
  counted cash and variance are refused to a cashier by the database layer
  itself, however the request is written.
* **One copy at a time** per Windows user. A second copy explains and closes.
* Operator guide: [`V1-OPERATOR-GUIDE.md`](V1-OPERATOR-GUIDE.md).

## Sign-offs that must be done by a person

These were **not** performed and are **not** claimed.

### 1. Physical thermal printer — UNVERIFIED

On the till, with the real printer, as a cashier:
1. Ring a counter sale with a kitchen note; print the **receipt** and the
   **kitchen ticket**. Check: both print, nothing is cut off at the paper width,
   the kitchen ticket shows no prices, Arabic renders correctly on the ticket.
2. Ring a WhatsApp/Delivery order with a delivery charge; print the receipt.
   Check the fenced "customer paid driver" block is present and legible.
3. Close a shift and print the shift report.
4. Record: printer model, driver version, paper width, pass/fail per document.

### 2. Windows display scaling at 125% — UNVERIFIED

Set Windows *Display → Scale* to 125% on the till's own 1366×768 (or actual)
screen, restart Greaz, and as a cashier check that the register, the payment
panel, the delivery panel and the shift close screen are fully visible without
horizontal scrolling and every button is reachable. Repeat at 100%.

### 3. Restore on a second machine — UNVERIFIED (GZ-G1-R1)

Follow `OPERATOR-BACKUP-RUNBOOK.md` to take a closed-database backup on the till,
carry it to a **different** Windows PC with this same installer, restore it, and
sign in as the owner. Check the last receipt number, today's sales total and one
product's stock match the till. Record both machines' names and the date.

### 4. Installer on the real till

Install the MSI or the setup.exe **as the till's own Windows account**, confirm
the SHA-256 first, launch, complete owner enrollment, and store the recovery
code off the machine.
