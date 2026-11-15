// @vitest-environment jsdom
/**
 * Codex V1.1 P2 — a cost the session may not read is WITHHELD, not zero.
 *
 * A cashier's projection correctly left the COGS columns out of every memo
 * read, and the mapper then filled the gap with `?? 0`, so the Returns screen
 * printed "$0.00" under "Cost reversed" — a false figure. Now the mapper yields
 * NULL, the cost column / stat / total / line cell are not rendered at all for
 * a cashier, and an owner's or manager's genuine $0.00 still shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../../src/lib/i18n";
import { useSession } from "../../src/state/session";

const sqlSeen: string[] = [];
const query = vi.fn();
vi.mock("../../src/db/client", () => ({
  query: (sql: string, params: unknown[]) => query(sql, params),
  execute: vi.fn(),
}));
vi.mock("../../src/state/activeContext", () => ({
  useActiveContext: () => ({ storeId: "store-1", userId: "u-1", hydrated: true }),
}));

import Returns from "../../src/pages/Returns";
import { creditMemosRepo } from "../../src/db/repos/creditMemos";

const MEMO = {
  id: "memo-1",
  store_id: "store-1",
  original_sale_id: "sale-1",
  credit_memo_number: 5,
  shift_id: "shift-1",
  device_id: null,
  cashier_user_id: "u-1",
  exchange_rate_lbp_per_usd: 89_500,
  exchange_rate_id: "rate-1",
  reason: null,
  subtotal_excl_vat_cents: 451,
  vat_total_cents: 49,
  discount_cents: 0,
  total_incl_vat_cents: 500,
  refund_total_usd_cents: 500,
  status: "posted",
  created_at: "2026-11-15T10:00:00.000Z",
  posted_at: "2026-11-15T10:00:00.000Z",
  notes: null,
  original_receipt_number: 42,
};
const LINE = {
  id: "ml-1",
  credit_memo_id: "memo-1",
  store_id: "store-1",
  original_sale_item_id: "si-1",
  product_id: "p-1",
  product_name_snapshot: "Burger",
  product_sku_snapshot: null,
  vat_rate_id_snapshot: "vat-11",
  vat_rate_bps_snapshot: 1100,
  quantity_base: 1,
  quantity_in_uom: 1,
  uom_code_snapshot: "each",
  factor_num_snapshot: 1,
  factor_den_snapshot: 1,
  unit_price_excl_vat_cents: 451,
  unit_price_incl_vat_cents: 500,
  line_subtotal_excl_vat_cents: 451,
  line_vat_cents: 49,
  line_total_incl_vat_cents: 500,
  line_discount_cents: 0,
  is_service: 1,
  return_to_stock: 0,
  related_movement_id: null,
  created_at: "2026-11-15T10:00:00.000Z",
};
const COST = {
  cogs_reversed_cents: 0,
  unit_cogs_excl_vat_microcents: 0,
  unit_cogs_excl_vat_cents: 0,
  line_cogs_excl_vat_cents: 0,
};

/** Serve the memo exactly as the read channel would: cost columns only if asked for. */
function serve() {
  query.mockImplementation(async (sql: string) => {
    sqlSeen.push(sql);
    const withCost = /cogs/.test(sql);
    if (/FROM stores/.test(sql)) return [{ name: "Greaz" }];
    if (/FROM sales_credit_memo_lines/.test(sql)) return [withCost ? { ...LINE, ...COST } : LINE];
    if (/FROM sales_credit_memo_refunds/.test(sql)) return [];
    if (/FROM sales_credit_memos/.test(sql)) {
      return [withCost ? { ...MEMO, cogs_reversed_cents: COST.cogs_reversed_cents } : MEMO];
    }
    return [];
  });
}

function asRole(role: "owner" | "manager" | "cashier") {
  useSession.setState({ status: { session: { role } } } as never);
}

async function openTheMemo() {
  render(
    <MemoryRouter>
      <I18nProvider>
        <Returns />
      </I18nProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByText("#5"));
  await screen.findAllByText("Burger");
}

beforeEach(() => {
  sqlSeen.length = 0;
  query.mockReset();
  serve();
});
afterEach(() => {
  cleanup();
  useSession.setState({ status: null } as never);
});

describe("a cashier", () => {
  it("reads no cost column and sees no cost figure — list, stat, detail, totals or lines", async () => {
    asRole("cashier");
    await openTheMemo();
    expect(sqlSeen.some((s) => /cogs/i.test(s))).toBe(false);
    expect(screen.queryByText("Cost reversed")).toBeNull();
    expect(screen.queryByText("Cost returned to stock")).toBeNull();
  });

  it("gets NULL, not 0, from the mapper", async () => {
    asRole("cashier");
    const memo = await creditMemosRepo.findByIdWithDetails("memo-1");
    expect(memo?.cogsReversedCents).toBeNull();
    expect(memo?.lines[0].lineCogsExclVatCents).toBeNull();
    expect(memo?.lines[0].unitCogsExclVatMicrocents).toBeNull();
    expect(memo?.lines[0].unitCogsExclVatCents).toBeNull();
    const list = await creditMemosRepo.list({ storeId: "store-1" });
    expect(list[0].cogsReversedCents).toBeNull();
  });
});

describe.each(["owner", "manager"] as const)("an %s", (role) => {
  it("sees the cost figures, and a genuine zero is printed as $0.00", async () => {
    asRole(role);
    await openTheMemo();
    expect(sqlSeen.some((s) => /cogs_reversed_cents/.test(s))).toBe(true);
    // List column + list stat + detail stat + detail line column.
    await waitFor(() => expect(screen.getAllByText("Cost reversed").length).toBeGreaterThanOrEqual(3));
    expect(screen.getByText("Cost returned to stock")).toBeTruthy();
    const memo = await creditMemosRepo.findByIdWithDetails("memo-1");
    expect(memo?.cogsReversedCents).toBe(0);
    expect(memo?.lines[0].lineCogsExclVatCents).toBe(0);
  });
});
