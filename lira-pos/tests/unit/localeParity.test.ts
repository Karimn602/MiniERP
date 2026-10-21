/**
 * English and Arabic must describe the SAME application.
 *
 * Greaz runs in Arabic for its staff and English for its owner, and a missing
 * key does not fail a build or a typecheck — `t("drivers.colFees")` with no
 * Arabic entry renders the key, or nothing, on a live till. The register
 * already gates posting on VERDICTS rather than on message text for exactly
 * this reason (see `canPost`), but a label the cashier cannot read is still a
 * cashier who cannot work.
 *
 * WP-6 added around sixty keys in two files by hand, which is the kind of
 * change that drops one. So the shapes are compared structurally, both ways.
 */
import { describe, expect, it } from "vitest";
import en from "../../src/locales/en";
import ar from "../../src/locales/ar";

/** Every leaf path of a nested dictionary, as dot-joined strings. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    leafPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

/** The `{{placeholders}}` a message interpolates, sorted. */
function placeholders(message: string): string[] {
  const found = message.match(/\{\{(\w+)\}\}/g) ?? [];
  return [...new Set(found.map((m) => m.slice(2, -2)))].sort();
}

function leafAt(dict: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, part) =>
        typeof acc === "object" && acc !== null
          ? (acc as Record<string, unknown>)[part]
          : undefined,
      dict,
    );
}

const enPaths = leafPaths(en).sort();
const arPaths = leafPaths(ar).sort();

describe("locale parity", () => {
  it("has an Arabic string for every English one", () => {
    const missing = enPaths.filter((p) => !arPaths.includes(p));
    expect(missing).toEqual([]);
  });

  it("has an English string for every Arabic one", () => {
    // The other direction matters too: a key only Arabic has is one the English
    // UI will render raw, and it usually means a rename landed in one file.
    const extra = arPaths.filter((p) => !enPaths.includes(p));
    expect(extra).toEqual([]);
  });

  it("has no empty strings in either language", () => {
    const blank = [...enPaths, ...arPaths].filter((p) => {
      const value = leafAt(enPaths.includes(p) ? en : ar, p);
      return typeof value === "string" && value.trim() === "";
    });
    expect(blank).toEqual([]);
  });

  it("interpolates the SAME placeholders in both languages", () => {
    // A translated message that drops `{{amount}}` renders a sentence with the
    // number missing — which, on a settlement confirmation, is worse than an
    // untranslated one.
    const mismatched: string[] = [];
    for (const path of enPaths) {
      const e = leafAt(en, path);
      const a = leafAt(ar, path);
      if (typeof e !== "string" || typeof a !== "string") continue;
      const pe = placeholders(e);
      const pa = placeholders(a);
      if (pe.join(",") !== pa.join(",")) {
        mismatched.push(`${path}: en[${pe.join(",")}] vs ar[${pa.join(",")}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("covers the WP-6 delivery and driver vocabulary in both languages", () => {
    // Named explicitly rather than left to the structural check: these are the
    // strings a cashier reads while deciding who owes the shop money, so their
    // absence is a financial-clarity problem and not only a cosmetic one.
    const required = [
      "delivery.driver",
      "delivery.fee",
      "delivery.feeNote",
      "delivery.collectByDriver",
      "delivery.collectNote",
      "delivery.foodTotal",
      "delivery.driverFee",
      "delivery.customerPays",
      "delivery.err.driverRequired",
      "delivery.err.feeNeedsDriver",
      "delivery.err.driverNeedsDelivery",
      "delivery.err.feeInvalid",
      "drivers.title",
      "drivers.colOutstanding",
      "drivers.settleNote",
      "drivers.reportNote",
      "drivers.entry.collection",
      "drivers.entry.remittance",
      "drivers.entry.return_credit",
      "drivers.entry.adjustment",
      "drivers.err.exceedsOutstanding",
      "nav.drivers",
      "pos.errAttemptNotPersisted",
    ];
    for (const path of required) {
      expect(typeof leafAt(en, path), `en ${path}`).toBe("string");
      expect(typeof leafAt(ar, path), `ar ${path}`).toBe("string");
    }
  });

  it("relabels the delivery channel without renaming the stored value", () => {
    // The founder's orders arrive on WhatsApp, so the LABEL changed. The stored
    // channel is still `online_delivery`, because it is a reporting dimension
    // with history behind it — migration 014's rows and every report that
    // groups by it. Relabelling is presentation; renaming would be a migration
    // and a restatement.
    expect(en.channel.onlineDelivery).toMatch(/WhatsApp/i);
    expect(en.channel.onlineDeliveryShort).toMatch(/Delivery/i);
    expect(ar.channel.onlineDelivery).toContain("واتساب");
  });
});
