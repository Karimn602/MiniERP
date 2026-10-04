/**
 * SQL / read-model integration tests for the supplier balance (WP-05, GZ-HI-05).
 *
 * This is the read side of accounts payable: `supplierLedgerRepo.getBalance`,
 * `listBalances`, `decorateSuppliersWithBalances` and the `supplier_balances`
 * view are what the Suppliers list and the Supplier detail screen show, and
 * what a buyer decides how much to pay from.
 *
 * The invariant under test (Part J) is that there is ONE arithmetic: the figure
 * on screen must be `SUM(supplier_ledger.amount_cents)` over the same rows that
 * `post_supplier_payment` checks a payment against. A read model that reversed
 * a sign, filtered an entry type, or scoped differently would show a buyer a
 * balance the posting commands do not believe — and the buyer would pay against
 * the one on screen.
 *
 * Authority note: the posting commands themselves are covered by the Rust suite
 * (`src-tauri/src/tests/supplier_ap.rs`, `supplier_payments.rs`), which posts
 * through the real seams. This layer runs repository SQL against node:sqlite
 * with the Tauri SQL plugin mocked out — see tests/README.md.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/client", () => import("../helpers/mockClient"));

import { setTestDb } from "../helpers/mockClient";
import {
  createSqlTestDb,
  insertLedgerEntry,
  insertSupplierPurchase,
  resetIds,
  seedSupplier,
} from "../helpers/sqlDb";
import { supplierLedgerRepo, decorateSuppliersWithBalances } from "../../src/db/repos/supplierLedger";
import { suppliersRepo } from "../../src/db/repos/suppliers";

const BEIRUT = "sup-beirut";
const TRIPOLI = "sup-tripoli";

let db: DatabaseSync;

beforeEach(() => {
  resetIds();
  db = createSqlTestDb();
  setTestDb(db);
  seedSupplier(db, { id: BEIRUT, name: "Beirut Wholesale" });
  seedSupplier(db, { id: TRIPOLI, name: "Tripoli Imports" });
});

describe("the supplier balance read model", () => {
  it("is zero for a supplier with no activity", async () => {
    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(0);
  });

  it("equals the purchase total a posted invoice raised", async () => {
    // $20.00 of goods + 11% VAT = $22.20 owed. The payable is the gross, which
    // is what the shop actually has to hand over.
    insertSupplierPurchase(db, {
      supplierId: BEIRUT,
      purchaseDate: "2026-03-01",
      subtotalExclVat: 2_000,
      vat: 220,
      supplierReference: "INV-1",
    });

    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(2_220);
  });

  it("reconciles through a month of invoices, payments and a credit note", async () => {
    insertSupplierPurchase(db, {
      supplierId: BEIRUT,
      purchaseDate: "2026-03-01",
      subtotalExclVat: 2_000,
      vat: 220,
      supplierReference: "INV-1",
    });
    insertSupplierPurchase(db, {
      supplierId: BEIRUT,
      purchaseDate: "2026-03-08",
      subtotalExclVat: 1_000,
      vat: 110,
      supplierReference: "INV-2",
    });
    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(3_330);

    // A part payment.
    insertLedgerEntry(db, {
      supplierId: BEIRUT,
      entryType: "payment",
      amountSignedCents: -1_000,
      entryDate: "2026-03-10",
    });
    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(2_330);

    // A credit note for short-delivered goods.
    insertLedgerEntry(db, {
      supplierId: BEIRUT,
      entryType: "credit_note",
      amountSignedCents: -330,
      entryDate: "2026-03-12",
    });
    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(2_000);

    // And the rest, to exactly zero.
    insertLedgerEntry(db, {
      supplierId: BEIRUT,
      entryType: "payment",
      amountSignedCents: -2_000,
      entryDate: "2026-03-20",
    });
    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(0);
  });

  it("reconciles invoice liabilities against the purchase totals that raised them", async () => {
    // The Part C invariant, seen from the read side: what the ledger says the
    // shop owes for invoices must equal what the purchase documents total.
    for (const [date, net, vat] of [
      ["2026-03-01", 2_000, 220],
      ["2026-03-08", 1_000, 110],
      ["2026-03-15", 777, 85],
    ] as const) {
      insertSupplierPurchase(db, {
        supplierId: BEIRUT,
        purchaseDate: date,
        subtotalExclVat: net,
        vat,
        supplierReference: `INV-${date}`,
      });
    }

    const [{ invoiced }] = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS invoiced
           FROM supplier_ledger WHERE supplier_id = ? AND entry_type = 'purchase'`,
      )
      .all(BEIRUT) as { invoiced: number }[];
    const [{ purchased }] = db
      .prepare(
        `SELECT COALESCE(SUM(total_incl_vat_cents), 0) AS purchased
           FROM purchases WHERE supplier_id = ? AND status = 'posted'`,
      )
      .all(BEIRUT) as { purchased: number }[];

    expect(invoiced).toBe(purchased);
    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(purchased);
  });

  it("shows a credit on file as a negative balance rather than flipping its sign", async () => {
    // A supplier can genuinely owe the shop, through a credit note larger than
    // the balance. The read model must report that as negative — the Supplier
    // screen is what turns it into the words "credit on file", and a repo that
    // took an absolute value would show a debt instead.
    insertLedgerEntry(db, {
      supplierId: BEIRUT,
      entryType: "opening_balance",
      amountSignedCents: 1_000,
      entryDate: "2026-03-01",
    });
    insertLedgerEntry(db, {
      supplierId: BEIRUT,
      entryType: "credit_note",
      amountSignedCents: -3_000,
      entryDate: "2026-03-02",
    });

    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(-2_000);
  });

  it("keeps each supplier's balance to itself", async () => {
    insertSupplierPurchase(db, {
      supplierId: BEIRUT,
      purchaseDate: "2026-03-01",
      subtotalExclVat: 2_000,
      vat: 220,
      supplierReference: "B-1",
    });
    insertSupplierPurchase(db, {
      supplierId: TRIPOLI,
      purchaseDate: "2026-03-01",
      subtotalExclVat: 1_000,
      vat: 110,
      supplierReference: "T-1",
    });
    insertLedgerEntry(db, {
      supplierId: BEIRUT,
      entryType: "payment",
      amountSignedCents: -2_220,
      entryDate: "2026-03-05",
    });

    expect(await supplierLedgerRepo.getBalance(BEIRUT)).toBe(0);
    expect(await supplierLedgerRepo.getBalance(TRIPOLI)).toBe(1_110);
  });

  it("gives the same answer however the balance is asked for", async () => {
    // Four read paths — the repo's single-supplier sum, its per-store map, the
    // decorated list the Suppliers page renders, and the `supplier_balances`
    // view — must not be allowed to drift apart.
    insertSupplierPurchase(db, {
      supplierId: BEIRUT,
      purchaseDate: "2026-03-01",
      subtotalExclVat: 2_000,
      vat: 220,
      supplierReference: "INV-1",
    });
    insertLedgerEntry(db, {
      supplierId: BEIRUT,
      entryType: "payment",
      amountSignedCents: -1_200,
      entryDate: "2026-03-05",
    });

    const single = await supplierLedgerRepo.getBalance(BEIRUT);
    expect(single).toBe(1_020);

    const map = await supplierLedgerRepo.listBalances(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(map.get(BEIRUT)?.balanceCents).toBe(single);

    const suppliers = await suppliersRepo.list({
      storeId: "00000000-0000-0000-0000-000000000001",
    });
    const decorated = await decorateSuppliersWithBalances(
      "00000000-0000-0000-0000-000000000001",
      suppliers,
    );
    expect(decorated.find((s) => s.id === BEIRUT)?.balanceCents).toBe(single);

    const [view] = db
      .prepare("SELECT balance_cents FROM supplier_balances WHERE supplier_id = ?")
      .all(BEIRUT) as { balance_cents: number }[];
    expect(view.balance_cents).toBe(single);
  });

  it("reports a supplier with no activity as a zero balance, not as missing", async () => {
    // `decorateSuppliersWithBalances` has to default, because a supplier with
    // no ledger rows has no row in the aggregate. Showing nothing where a $0.00
    // belongs is how a list stops being readable.
    const suppliers = await suppliersRepo.list({
      storeId: "00000000-0000-0000-0000-000000000001",
    });
    const decorated = await decorateSuppliersWithBalances(
      "00000000-0000-0000-0000-000000000001",
      suppliers,
    );

    expect(decorated).toHaveLength(2);
    for (const s of decorated) {
      expect(s.balanceCents).toBe(0);
      expect(s.lastActivityAt).toBeNull();
    }
  });

  it("lists a supplier's entries newest first, with the signs as posted", async () => {
    insertSupplierPurchase(db, {
      supplierId: BEIRUT,
      purchaseDate: "2026-03-01",
      subtotalExclVat: 2_000,
      vat: 220,
      supplierReference: "INV-1",
    });
    insertLedgerEntry(db, {
      supplierId: BEIRUT,
      entryType: "payment",
      amountSignedCents: -1_000,
      entryDate: "2026-03-10",
      paymentReference: "CHQ-77",
    });

    const entries = await supplierLedgerRepo.listForSupplier(BEIRUT);
    expect(entries.map((e) => [e.entryType, e.amountSignedCents])).toEqual([
      ["payment", -1_000],
      ["purchase", 2_220],
    ]);
    expect(entries[0].relatedPaymentId).toBe("CHQ-77");
    // The displayed total is the sum of exactly what is listed.
    expect(entries.reduce((sum, e) => sum + e.amountSignedCents, 0)).toBe(
      await supplierLedgerRepo.getBalance(BEIRUT),
    );
  });
});

describe("the ledger sign convention, in the database", () => {
  // The same guard the Rust suite exercises through the posting commands,
  // asserted here against the migrated schema this layer builds: a read model
  // can only be trusted if the rows underneath it cannot carry an inverted
  // meaning in the first place.

  it("refuses a payment row that would increase the payable", () => {
    expect(() =>
      insertLedgerEntry(db, {
        supplierId: BEIRUT,
        entryType: "payment",
        amountSignedCents: 1_000,
        entryDate: "2026-03-10",
      }),
    ).toThrow(/must be negative/);

    expect(db.prepare("SELECT COUNT(*) AS n FROM supplier_ledger").get()).toMatchObject({ n: 0 });
  });

  it("refuses a credit note that would increase the payable", () => {
    expect(() =>
      insertLedgerEntry(db, {
        supplierId: BEIRUT,
        entryType: "credit_note",
        amountSignedCents: 500,
        entryDate: "2026-03-10",
      }),
    ).toThrow(/must be negative/);
  });

  it("refuses an invoice liability that would reduce the payable", () => {
    expect(() =>
      insertLedgerEntry(db, {
        supplierId: BEIRUT,
        entryType: "purchase",
        amountSignedCents: -500,
        entryDate: "2026-03-10",
      }),
    ).toThrow(/cannot be negative/);
  });

  it("allows both directions for the two bidirectional entry types", () => {
    for (const entryType of ["opening_balance", "adjustment"] as const) {
      for (const amount of [750, -750]) {
        expect(() =>
          insertLedgerEntry(db, {
            supplierId: BEIRUT,
            entryType,
            amountSignedCents: amount,
            entryDate: "2026-03-10",
            notes: "signed off",
          }),
        ).not.toThrow();
      }
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM supplier_ledger").get()).toMatchObject({ n: 4 });
  });
});
