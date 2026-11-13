# Greaz POS V1 — release candidate notes

| | |
|---|---|
| Source commit | `518e4f81ef4a144e7074f040412c75eea12acda6` (branch `sandbox/greaz-training`) |
| Supersedes | the `1a6aa9b` candidate (see the end of this file) — **do not install it** |
| Version | 0.1.0 |
| Built | 2026-11-13T08:24–08:26Z, `npm run tauri build`, production configuration (`com.greazlb.pos`), in a clean detached git worktree at that commit |
| Code signing | **NONE.** No signing process was run. SmartScreen will warn. |

## Installers

| File | Bytes | SHA-256 |
|---|---|---|
| `Greaz POS_0.1.0_x64_en-US.msi` | 5,955,584 | `876a512e78b34d27d7905bc7709a59e73f794a60f728e8b6c6ee5ab787f814ac` |
| `Greaz POS_0.1.0_x64-setup.exe` | 4,118,876 | `f80a8e83fa5b99fbaebb27b264464598888aa068a96ea0580858400e74f254bc` |

Verify before installing (PowerShell): `Get-FileHash '<file>' -Algorithm SHA256`.

The file NAMES are the same as every earlier candidate's; only the hashes above
identify this one. **Do not use any other installer**, in particular anything in
`src-tauri/target/release/bundle/` on the development machine: that folder holds
October builds (`Greaz POS RC1_…`, `WP6_…`, `SANDBOX_…`), acceptance builds under
test identities, and the superseded `1a6aa9b` candidate.

### Build provenance

The installers were built by `npm run tauri build` in a detached `git worktree`
of commit `518e4f8`, after `npm ci` from the committed lockfiles. The retained
transcript (`build-transcript.log`, archived with the installers) records, from
the same shell session as the build:

* HEAD `518e4f81ef4a144e7074f040412c75eea12acda6`, 0 tracked changes and no
  untracked files before the build;
* node v24.15.0, npm 12.0.2, rustc 1.95.0, cargo 1.95.0, tauri-cli 2.11.1;
* the SHA-256 of `package-lock.json` and `Cargo.lock`;
* build exit 0, and the SHA-256, size and timestamp of each installer as the
  build left it — identical to the table above.

One tracked file differed after the build: the Tauri CLI rewrote
`src-tauri/Cargo.toml`'s line endings (CRLF → LF). Its content is byte-identical
to the committed blob once line endings are normalised, and `git diff` is empty;
both facts are recorded in the transcript.

Archive (development machine, not tracked): `lira-pos/dev/release-v1-518e4f8/`
— both installers, `build-transcript.log`, a `git archive` of the source at that
commit, `SOURCE-COMMIT.txt` and `SHA256SUMS.txt`.

These installers were **built but not installed or run on the build machine**:
the production identity's database there is protected data. Packaged behaviour
was proven with the same commit built under a disposable identifier (only
`identifier`, `productName` and the window title differ).

## What changed since the last candidate

* **VAT is worked out by the till, not taken from the request** (GZ-VAT-1). A
  new sale line must carry its product's own VAT rate (standard, zero-rated or
  exempt, as configured), and its revenue/VAT split must be that rate applied
  to the line's charged total — the same rule the register has always used. A
  request that moves revenue into VAT (or VAT into revenue) with the customer's
  total unchanged, or that claims a taxable item is exempt, is refused and
  nothing is written. Sales already posted are not re-judged.
* Unchanged from the previous candidate: discount control on the real discount
  (GZ-B-P1), cashier confidentiality (Stage C), one copy at a time.
* Operator guide: [`V1-OPERATOR-GUIDE.md`](V1-OPERATOR-GUIDE.md).

## Verification of this commit

| Check | Result |
|---|---|
| `npm run verify` at `518e4f8` | exit 0 — vitest 1,178 passed (53 files); tsc (tests) clean; production frontend build ok; cargo test 1,095 passed, 0 failed, **0 ignored**; cargo check ok |
| Independent review (Codex CLI, read-only, scoped to the VAT change) | **PASS WITH NONBLOCKING FINDINGS** — 0 P0, 0 P1, 1 P2 (below) |
| Packaged acceptance, fresh disposable identity `com.greazlb.pos.v1vatpkg` | 63/64 scripted checks; the one failure was a check in the script (it looked for the button text before a cart existed); a follow-up probe on the same running app showed the register rendering and posting — see the handoff |
| Protected databases | all 56 byte-identical before and after |

Known P2: for a single line above about $9 billion the register's
floating-point arithmetic can differ by a cent from the backend's exact
integers, and the sale would be refused (never misstated).

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

### 2. Windows display scaling at 100% and 125% — UNVERIFIED

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

### 5. Backup owner and destination

Name the person responsible for backups and the destination they go to (and
how often), per `OPERATOR-BACKUP-RUNBOOK.md`. Not yet assigned.

### 6. Windows account protection and recovery code

A separate non-administrator Windows account for the till, with a password and
idle lock; BitLocker where available; the recovery code stored off the machine
(operator guide §1). Not yet confirmed on the real till.

### 7. VAT configuration and fiscal reporting

The software now enforces the VAT rate each product is configured with; it
does **not** decide which rate is correct. The shop (with its accountant) must
confirm every menu item's VAT classification and accept the VAT and sales
reports as fit for its filings. The VAT treatment of the driver's delivery
charge is still an open question for the accountant (it is recorded outside
every sale total and carries no VAT). `vat_rates` effective dates are not
consulted by the till.

---

## Superseded candidate — do not install

Built from `1a6aa9b8f0d0e181ad5a7eadd6a8e0c45e2538c1` on 2026-11-12. It does
**not** contain the VAT correction. Listed only so it can be recognised:

| File | SHA-256 |
|---|---|
| `Greaz POS_0.1.0_x64_en-US.msi` | `a7b4c46abdefb7fc946eb9a7d9d42c6df966098146062aa9d16549980da240cd` |
| `Greaz POS_0.1.0_x64-setup.exe` | `6202177fb0db8c3891e769c815d2fb88a29a01c13a4f3af0788a5702d66a4020` |
