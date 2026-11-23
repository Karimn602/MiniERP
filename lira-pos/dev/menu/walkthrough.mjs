/**
 * OFFICIAL MENU INTEGRATION — desktop walkthrough on DISPOSABLE identities.
 *
 *   node dev/menu/walkthrough.mjs <port> <identity> <phase> <evidenceDir>
 *
 * Phases:
 *   fresh    — a brand-new install: enroll, the owner's first-run prompt, the
 *              real dialog, load the menu, the Register's tabs and tiles, a sale
 *              rung through real tile clicks with sauce/dip choices, an
 *              ingredient made through the real Products form.
 *   restart  — after the app was closed and relaunched: persistence, no
 *              duplicates, no prompt, a second load refused.
 *   exist    — a COPY of an earlier disposable V1.1 acceptance database (real
 *              posted sales, shifts, users, purchases, a recipe): the menu is
 *              loaded and every pre-existing row is proved unchanged.
 *
 * Evidence classes (CLAUDE.md): clicks are real mouse events and F5 is a real
 * key event, both dispatched into the WebView over CDP; the VAT <select> is set
 * by SIMULATED UI INTERACTION (a React change event) and is reported as such;
 * setup steps and every read-back go through IPC.
 *
 * SAFETY: refuses any identity that is not one of the three named here.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { connect, makeChecker, sleep } from "../v11/cdp.mjs";

const [PORT, IDENTITY, PHASE, OUT] = process.argv.slice(2);
const ALLOWED = ["com.greazlb.pos.menufresh", "com.greazlb.pos.menuexist", "com.greazlb.pos.menutrn"];
if (!ALLOWED.includes(IDENTITY)) throw new Error(`REFUSING identity ${IDENTITY}`);
mkdirSync(OUT, { recursive: true });
const STATE = `${OUT}/state.json`;
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const { check, results } = makeChecker(`${IDENTITY.split(".").pop()}:${PHASE}`);
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
const TODAY = new Date().toISOString().slice(0, 10);
const OWNER_PASS = IDENTITY.endsWith("menuexist") ? "olivegrove" : "menuowner";

const EXPECTED = JSON.parse(readFileSync(new URL("../../src/catalog/greaz-menu-v1.json", import.meta.url), "utf8"));
const SECTION = { Burgers: "burgers", Wraps: "wraps", Fries: "fries", Appetizers: "appetizers", Combos: "combos", Drinks: "drinks", Dessert: "dessert", "Add-ons": "addons", "Combo Upgrades": "upgrades" };

async function must(c, name, cmd, args) {
  const r = await c.invoke(cmd, args);
  check(name, r.ok, r.ok ? "" : r.error);
  if (!r.ok) throw new Error(`cannot continue after: ${name}`);
  return r.value;
}

/** Prove the identity from the database's own path before touching anything. */
async function proveIdentity(c) {
  const st = (await c.invoke("auth_status")).value;
  const file = (st.enrollmentCodeFile ?? st.databasePath ?? "").replace(/\\/g, "/");
  return { st, file };
}

async function openRegister(c) {
  await c.evaluate("location.assign('/')");
  await sleep(2000);
}

/** Click the menu chip whose label starts with `label`, then a tile by name. */
async function ring(c, chip, name) {
  await c.click("button[aria-pressed]", `^${chip}`);
  // Tiles are matched by their exact title (the item name): "OG Chicken" is a
  // burger AND a wrap, so the chip above is what decides which one.
  const want = name.replace(/^\^|\$$/g, "").replace(/\\\+/g, "+");
  const p = await c.evaluate(`(() => {
    const el = [...document.querySelectorAll('button.group\\\\/tile')].find((b) => b.title === ${JSON.stringify(want)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  if (!p) throw new Error(`no tile titled ${want} under ${chip}`);
  await sleep(60);
  await c.mouse(p.x, p.y);
  await sleep(250);
}

// ---------------------------------------------------------------------------
async function loadMenuThroughTheDialog(c, { hideSamples = [] } = {}) {
  await openRegister(c);
  await c.waitFor("[data-testid='official-menu-prompt']", null, 20000);
  check("the owner sees the first-run prompt on the Register", true);
  await c.screenshot(`${OUT}/01-register-prompt.png`);
  await c.click("[data-testid='official-menu-prompt'] button", "Review and load");
  await c.waitFor("[data-testid='official-menu-row-GRZ-BUR-001']", null, 20000);
  const rows = await c.evaluate("document.querySelectorAll('[data-testid^=official-menu-row-]').length");
  check("the dialog previews all 33 catalog entries", rows === 33, String(rows));
  const apply = await c.locate("[data-testid='official-menu-apply']");
  check("Load is disabled before the tax treatment is chosen", apply?.disabled === true);
  await c.screenshot(`${OUT}/02-dialog-before-tax.png`);

  // SIMULATED UI INTERACTION for the native <select>.
  const vatId = (await c.select("SELECT id FROM vat_rates WHERE rate_bps = 1100 AND is_exempt = 0 LIMIT 1"))[0].id;
  await c.chooseByLabel("^VAT rate", vatId);
  await c.click("[data-testid='official-menu-mode-inclusive']");
  check("still disabled until the treatment is confirmed", (await c.locate("[data-testid='official-menu-apply']"))?.disabled === true);
  const example = await c.evaluate("document.querySelector('[data-testid=official-menu-example]')?.innerText ?? ''");
  check("the dialog states what the customer pays", /pays \$7\.00/.test(example), example);
  await c.click("[data-testid='official-menu-confirm']");
  for (const id of hideSamples) await c.click(`[data-testid='official-menu-hide-${id}']`);
  await c.screenshot(`${OUT}/03-dialog-ready.png`);
  await c.click("[data-testid='official-menu-apply']");
  await c.waitFor("[data-testid='official-menu-applied']", null, 20000);
  await c.screenshot(`${OUT}/04-dialog-loaded.png`);
  await c.click("[data-testid='official-menu-close']");
  await sleep(1200);
  return vatId;
}

async function checkCatalogRows(c, vatId) {
  const rows = await c.select(
    `SELECT sku, name, category, description, icon, price_incl_vat_cents incl, price_excl_vat_cents excl,
            vat_rate_id, vat_pricing_mode, is_service, is_active, show_on_register, quantity_on_hand,
            costing_method, (SELECT COUNT(*) FROM product_barcodes b WHERE b.product_id = p.id) barcodes,
            (SELECT COUNT(*) FROM product_uoms u WHERE u.product_id = p.id) uoms
       FROM products p WHERE sku LIKE 'GRZ-%' ORDER BY sku`,
  );
  check("exactly 33 official products exist", rows.length === 33, String(rows.length));
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  const bad = [];
  for (const e of EXPECTED.items) {
    const r = bySku.get(e.sku);
    const want = {
      name: e.name, category: SECTION[e.category], description: e.description || null, icon: e.icon_suggestion,
      incl: e.price_usd_cents, vat_rate_id: vatId, vat_pricing_mode: "inclusive", is_service: 1, is_active: 1,
      show_on_register: e.status === "active" ? 1 : 0, quantity_on_hand: 0, costing_method: "purchase_average", barcodes: 0, uoms: 1,
    };
    for (const [k, v] of Object.entries(want)) if (!r || r[k] !== v) bad.push(`${e.sku}.${k}=${r?.[k]} want ${v}`);
  }
  check("every name, section, description, icon and printed price matches the catalog; no barcode, stock or cost", bad.length === 0, bad.slice(0, 5).join("; "));
  check("OG Chicken is two products with two SKUs", rows.filter((r) => r.name === "OG Chicken").map((r) => r.sku).join() === "GRZ-BUR-003,GRZ-WRP-002");
}

async function checkRegisterAppearance(c, file, expectedTiles = 32, tileLabel = "32 sellable tiles (27 menu − dessert + 4 add-ons + 2 upgrades)") {
  await openRegister(c);
  await c.waitFor("button.group\\/tile", "Double Smash", 20000);
  const chips = await c.evaluate("[...document.querySelectorAll('button[aria-pressed]')].map(b => b.innerText.replace(/\\s+/g,' ').trim())");
  check("Register tabs follow the printed menu order", /(^| \| )All [0-9]+ \| Burgers.*Wraps.*Fries.*Appetizers.*Combos.*Drinks.*Add-ons.*Combo upgrades/i.test(chips.join(" | ")), chips.join(" | "));
  check("no Dessert tab: the Coming Soon item is off the Register", !chips.some((x) => /^Dessert/i.test(x)));
  const tiles = await c.evaluate("[...document.querySelectorAll('button.group\\\\/tile')].map(b => b.title)");
  check(tileLabel, tiles.length === expectedTiles, `${tiles.length} (expected ${expectedTiles})`);
  check("Ice Cream Burger is not a tile", !tiles.includes("Ice Cream Burger"));
  check("no ingredient tiles (Meat, Potato Bun)", !tiles.some((t) => /^(Meat|Potato Bun)$/.test(t)));
  await c.screenshot(`${OUT}/${file}-register-all.png`);
  await c.click("button[aria-pressed]", "^Burgers");
  await c.screenshot(`${OUT}/${file}-register-burgers.png`);
  const burgerText = await c.text();
  check("a tile shows its description", /150g beef, 2 red cheddar slices/.test(burgerText));
  // Laptop practicality: at the 1366x768 window, nothing scrolls the page sideways.
  const overflow = await c.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  check("no horizontal page scroll at this window size", overflow <= 0, String(overflow));
}

// ---------------------------------------------------------------------------
async function phaseFresh(c) {
  const { st, file } = await proveIdentity(c);
  if (!file.includes(IDENTITY) || st.enrollmentState === "initialized") throw new Error(`REFUSING: not a fresh ${IDENTITY}: ${file}`);
  check("fresh disposable identity", true, file);
  const before = await c.invoke("db_select", { sql: "SELECT COUNT(*) n FROM products", params: [] });
  check("nothing is readable before sign-in", !before.ok);

  const code = readFileSync(st.enrollmentCodeFile, "utf8").split(/\r?\n/).map((l) => l.trim())
    .find((l) => l.startsWith("Enrollment code:")).replace("Enrollment code:", "").trim();
  const ownerId = st.accounts.find((a) => a.role === "owner").userId;
  await must(c, "owner enrolls", "auth_enroll_owner", { enrollmentCode: code, userId: ownerId, passphrase: OWNER_PASS });
  state.ownerId = ownerId;
  state.storeId = (await c.select("SELECT id FROM stores LIMIT 1"))[0].id;
  const preMenu = (await c.select("SELECT COUNT(*) n FROM products WHERE is_active = 1 AND show_on_register = 1"))[0].n;
  check("a new store has no sellable products before the menu is loaded (no silent seed)", preMenu === 0, String(preMenu));

  const vatId = await loadMenuThroughTheDialog(c);
  state.vatId = vatId;
  save();
  await checkCatalogRows(c, vatId);
  const marker = (await c.select("SELECT value FROM app_settings WHERE key LIKE 'official_menu.greaz_menu_reference_v1.%'"))[0]?.value ?? "";
  check("the load is recorded once, with the owner and the tax treatment", marker.includes(`"appliedByUserId":"${ownerId}"`) && marker.includes('"vatPricingMode":"inclusive"'), marker);

  // An ingredient through the REAL Products form: inventory-only, separate.
  await c.navigate("/products");
  await c.click("button", "^New product$");
  await c.field("^Name$");
  await c.type("Potato Bun");
  await c.chooseByLabel("Sold at the Register", "inventory");
  await c.chooseByLabel("VAT rate", vatId);
  await c.click("button", "^(Save|Create product)");
  await sleep(1500);
  const bun = (await c.select("SELECT show_on_register, is_service, sku FROM products WHERE name = 'Potato Bun'"))[0];
  check("an ingredient saved from Products stays off the Register and stocked", bun?.show_on_register === 0 && bun?.is_service === 0, JSON.stringify(bun));

  await checkRegisterAppearance(c, "05");

  // A sale, rung through real tile clicks.
  await must(c, "today's exchange rate (setup)", "exchange_rate_save", { args: { id: uuid(), storeId: state.storeId, effectiveDate: TODAY, rateLbpPerUsd: 89500, source: "manual", createdByUserId: ownerId } });
  await must(c, "open a shift (setup)", "open_shift", { payload: { shiftId: uuid(), storeId: state.storeId, deviceId: null, openedByUserId: ownerId, openingCashUsdCents: 5000, openingCashLbp: 0, notes: null } });
  await openRegister(c);
  await c.waitFor("button.group\\/tile", "Double Smash", 20000);

  await ring(c, "Burgers", "Dipper Chicken");
  await c.waitFor("[data-testid='menu-choice-dialog']");
  await c.screenshot(`${OUT}/06-dipper-sauce.png`);
  await c.click("[data-testid='menu-choice-Buffalo']");
  await ring(c, "Burgers", "^OG Chicken$");
  await ring(c, "Wraps", "^OG Chicken$");
  await ring(c, "Combos", "Greaz Box");
  await c.waitFor("[data-testid='menu-choice-dialog']");
  await c.click("[data-testid='menu-choice-plus-Honey mustard']");
  await c.click("[data-testid='menu-choice-plus-BBQ']");
  await c.click("[data-testid='menu-choice-plus-BBQ']");
  await c.screenshot(`${OUT}/07-greaz-box-dips.png`);
  await c.click("[data-testid='menu-choice-add']");
  await ring(c, "Fries", "Chicken Loaded Fries");
  await c.click("[data-testid='menu-choice-BBQ']");
  await ring(c, "Add-ons", "Beef Bacon Add-on");
  await ring(c, "Combo upgrades", "Fries \\+ Soft Drink Upgrade");
  await ring(c, "Drinks", "Water");
  await c.screenshot(`${OUT}/08-order-before-post.png`);
  await c.key("F5");
  await sleep(3000);
  await c.screenshot(`${OUT}/09-after-post.png`);

  const lines = await c.select(
    `SELECT p.sku, si.product_name_snapshot name, si.quantity_in_uom q, si.line_total_incl_vat_cents total,
            si.kitchen_note note, si.cogs_source src
       FROM sale_items si JOIN products p ON p.id = si.product_id JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'posted' ORDER BY p.sku`,
  );
  const got = lines.map((l) => `${l.sku}|${l.q}|${l.total}|${l.note ?? ""}`).join("\n");
  const want = [
    "GRZ-ADD-001|1|200|",
    "GRZ-BUR-003|1|700|",
    "GRZ-BUR-004|1|700|Sauce: Buffalo",
    "GRZ-CMB-002|1|1600|Dips: Honey mustard, BBQ ×2",
    "GRZ-DRK-002|1|50|",
    "GRZ-FRY-005|1|600|Sauce: BBQ",
    "GRZ-UPG-001|1|300|",
    "GRZ-WRP-002|1|700|",
  ].join("\n");
  check("the posted sale holds exactly the rung items, prices and choices", got === want, `\n${got}`);
  const sale = (await c.select("SELECT total_incl_vat_cents t, receipt_number r FROM sales WHERE status = 'posted'"))[0];
  check("receipt total = $48.50, the sum of printed prices", sale?.t === 4850, JSON.stringify(sale));
  check("menu lines post as uncosted (no invented cost)", lines.every((l) => l.src === "uncosted"));
  const moves = (await c.select("SELECT COUNT(*) n FROM inventory_movements"))[0].n;
  check("non-stock menu lines move no stock", moves === 0, String(moves));
  state.receipt = sale?.r;

  // The Coming Soon dessert is refused by the backend too.
  const dessert = (await c.select("SELECT id FROM products WHERE sku = 'GRZ-DES-001'"))[0].id;
  const shift = (await c.select("SELECT id FROM shifts WHERE status = 'open'"))[0].id;
  const rate = (await c.select("SELECT id, rate_lbp_per_usd r FROM exchange_rates ORDER BY created_at DESC LIMIT 1"))[0];
  const refused = await c.invoke("post_sale", { payload: {
    saleId: uuid(), storeId: state.storeId, cashierUserId: ownerId, deviceId: null, shiftId: shift,
    exchangeRateId: rate.id, exchangeRateLbpPerUsd: rate.r, notes: null, channel: "counter", driverId: null, deliveryFeeCents: 0,
    cogsMethod: "weighted_average", discountCents: 0, allowNegativeInventory: false,
    lines: [{ saleItemId: uuid(), productId: dessert, productNameSnapshot: "Ice Cream Burger", productSkuSnapshot: "GRZ-DES-001",
      uomCodeSnapshot: "each", factorNumSnapshot: 1, factorDenSnapshot: 1, quantityInUom: 1, quantityBase: 1,
      unitPriceExclVatCents: 586, unitPriceInclVatCents: 650, vatRateIdSnapshot: state.vatId, vatRateBpsSnapshot: 1100,
      lineSubtotalExclVatCents: 586, lineVatCents: 64, lineTotalInclVatCents: 650, lineDiscountCents: 0,
      barcodeUsedSnapshot: null, barcodeTypeSnapshot: null, kitchenNote: null, isService: true }],
    payments: [{ paymentId: uuid(), method: "cash_usd", currency: "USD", amountNativeUsdCents: 650, amountNativeLbp: 0, amountUsdCentsEquivalent: 650, reference: null }],
  } });
  check("post_sale refuses the Coming Soon dessert", !refused.ok, refused.error ?? "ACCEPTED");
  save();
}

async function phaseRestart(c) {
  const st = (await c.invoke("auth_status")).value;
  check("relaunched: enrollment is initialized, not repeated", st.enrollmentState === "initialized", st.enrollmentState);
  await c.invoke("auth_logout");
  await must(c, "owner signs in again", "auth_login", { userId: state.ownerId, secret: OWNER_PASS });
  const n = (await c.select("SELECT COUNT(*) n FROM products WHERE sku LIKE 'GRZ-%'"))[0].n;
  check("after restart: still exactly 33 official products (no re-seed)", n === 33, String(n));
  const markers = (await c.select("SELECT COUNT(*) n FROM app_settings WHERE key LIKE 'official_menu.%'"))[0].n;
  check("one load record", markers === 1);
  const sale = (await c.select("SELECT COUNT(*) n, SUM(total_incl_vat_cents) t FROM sales WHERE status = 'posted'"))[0];
  check("the posted sale persisted", sale.n === 1 && sale.t === 4850, JSON.stringify(sale));
  await openRegister(c);
  await c.waitFor("button.group\\/tile", "Double Smash", 20000);
  await sleep(1500);
  check("no first-run prompt once the menu is loaded", !(await c.locate("[data-testid='official-menu-prompt']")));
  await c.screenshot(`${OUT}/10-after-restart.png`);
  const again = await c.invoke("official_menu_apply", { payload: { storeId: state.storeId, catalogLabel: "greaz_menu_reference_v1", vatRateId: state.vatId, vatPricingMode: "inclusive", taxTreatmentConfirmed: true, replaceNameMatches: [], hideProductIds: [] } });
  check("a second load is refused", !again.ok && /already loaded/.test(again.error ?? ""), again.error ?? "ACCEPTED");
  const n2 = (await c.select("SELECT COUNT(*) n FROM products WHERE sku LIKE 'GRZ-%'"))[0].n;
  check("and still 33", n2 === 33);
}

// ---------------------------------------------------------------------------
const SNAPSHOT_TABLES = [
  "sales", "sale_items", "sale_payments", "shifts", "users", "purchases", "purchase_items",
  "inventory_movements", "recipes", "recipe_components", "sales_credit_memos", "supplier_ledger",
  "driver_ledger", "exchange_rates", "product_barcodes", "product_uoms", "sale_item_recipe_costs",
];
async function snapshot(c) {
  const out = {};
  // `users` credential/lockout columns are refused to every renderer tier by
  // read_guard; the offline row comparison after the phase covers them.
  const cols = { users: "id, store_id, full_name, role, active, created_at, updated_at" };
  for (const t of SNAPSHOT_TABLES) out[t] = await c.select(`SELECT ${cols[t] ?? "*"} FROM ${t} ORDER BY id`);
  // Products: every column; `show_on_register` and `updated_at` are reported
  // separately because a product the owner ticks may legitimately change them.
  out.products = await c.select("SELECT * FROM products WHERE sku IS NULL OR sku NOT LIKE 'GRZ-%' ORDER BY id");
  return out;
}

async function phaseExist(c) {
  const st = (await c.invoke("auth_status")).value;
  check("copied V1.1 database opens initialized", st.enrollmentState === "initialized", st.enrollmentState);
  const owner = st.accounts.find((a) => a.role === "owner");
  await c.invoke("auth_logout");
  await must(c, "the copied database's owner signs in", "auth_login", { userId: owner.userId, secret: OWNER_PASS });
  state.ownerId = owner.userId;
  state.storeId = (await c.select("SELECT id FROM stores LIMIT 1"))[0].id;
  const counts = (await c.select(`SELECT (SELECT COUNT(*) FROM sales WHERE status='posted') sales,
      (SELECT COUNT(*) FROM shifts) shifts, (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM purchases) purchases,
      (SELECT COUNT(*) FROM recipes) recipes, (SELECT COUNT(*) FROM products) products`))[0];
  check("the source has real history (sales, shifts, users, purchases, recipes)", counts.sales > 0 && counts.purchases > 0 && counts.recipes > 0, JSON.stringify(counts));
  const before = await snapshot(c);

  const pv = (await c.invoke("official_menu_preview", { storeId: state.storeId })).value;
  const ingredientIds = (await c.select("SELECT DISTINCT component_product_id id FROM recipe_components")).map((r) => r.id);
  check("no recipe ingredient is offered for hiding", !pv.samples.some((s) => ingredientIds.includes(s.productId)));
  check("no catalog item is blocked by an existing SKU", pv.items.every((i) => i.outcome !== "sku_exists"));
  const hide = pv.samples.filter((s) => /^Double Burger$/i.test(s.name)).map((s) => s.productId);
  check("existing Register items are offered for reconciliation, none pre-ticked", pv.samples.length > 0 && hide.length === 1, pv.samples.map((s) => s.name).join(", "));
  await loadMenuThroughTheDialog(c, { hideSamples: hide });

  const after = await snapshot(c);
  // Pre-existing rows are compared by primary key, column for column. New rows
  // (the official items' own units) are additions and are reported, not judged
  // here: the products check below accounts for what was created.
  for (const t of SNAPSHOT_TABLES) {
    const a = new Map(after[t].map((r) => [r.id, JSON.stringify(r)]));
    const bad = before[t].filter((r) => a.get(r.id) !== JSON.stringify(r)).map((r) => r.id);
    check(`${t}: every pre-existing row unchanged`, bad.length === 0,
      `${before[t].length} pre-existing, ${after[t].length - before[t].length} added${bad.length ? `, CHANGED/MISSING: ${bad.join(", ")}` : ""}`);
  }
  const newUoms = (await c.select("SELECT COUNT(*) n FROM product_uoms u JOIN products p ON p.id = u.product_id WHERE p.sku LIKE 'GRZ-%'"))[0].n;
  check("every added unit belongs to an official item", after.product_uoms.length - before.product_uoms.length === newUoms, `${newUoms}`);
  const changed = [];
  for (const p of before.products) {
    const q = after.products.find((x) => x.id === p.id);
    for (const k of Object.keys(p)) {
      if (k === "show_on_register" || k === "updated_at") continue;
      if (JSON.stringify(p[k]) !== JSON.stringify(q?.[k])) changed.push(`${p.name}.${k}`);
    }
    const flipped = p.show_on_register !== q?.show_on_register;
    if (flipped && !hide.includes(p.id)) changed.push(`${p.name}.show_on_register (not ticked)`);
  }
  check("no existing product's price, VAT, cost, stock, name or SKU changed", changed.length === 0, changed.join(", "));
  const hidden = after.products.filter((p) => hide.includes(p.id));
  check("only the ticked sample was taken off the Register, and it is still active", hidden.length === 1 && hidden[0].show_on_register === 0 && hidden[0].is_active === 1, JSON.stringify(hidden.map((h) => [h.name, h.show_on_register, h.is_active])));
  const grz = (await c.select("SELECT COUNT(*) n FROM products WHERE sku LIKE 'GRZ-%'"))[0].n;
  // Expected creations come from the PREVIEW the owner reviewed: an existing
  // same-named Register item is kept (no Replace ticked), never duplicated.
  const toCreate = pv.items.filter((i) => i.outcome === "create");
  const kept = pv.items.filter((i) => i.outcome === "name_match");
  check("official products created = the preview's 'create' rows (same-named items kept, not duplicated)",
    grz === toCreate.length && grz + kept.length === 33,
    `${grz} created, ${kept.length} kept: ${kept.map((i) => `${i.name}→existing ${i.existing.map((e) => e.name).join("/")}`).join(", ")}`);
  const marker = JSON.parse((await c.select("SELECT value FROM app_settings WHERE key LIKE 'official_menu.%'"))[0].value);
  check("the load record agrees", marker.created === toCreate.length && marker.keptExistingByName === kept.length && marker.hiddenFromRegister === hide.length,
    JSON.stringify({ created: marker.created, kept: marker.keptExistingByName, hidden: marker.hiddenFromRegister }));
  const keptIds = kept.flatMap((i) => i.existing.map((e) => e.productId ?? e.id));
  const keptAfter = after.products.filter((p) => keptIds.includes(p.id));
  check("the kept same-named items are still on the Register", keptAfter.length === kept.length && keptAfter.every((p) => p.show_on_register === 1 && p.is_active === 1),
    JSON.stringify(keptAfter.map((p) => [p.name, p.price_incl_vat_cents, p.show_on_register])));
  // Tiles: pre-existing Register items, minus the ticked one, plus the new
  // sellable items (the Coming Soon dessert is created off the Register).
  const preTiles = before.products.filter((p) => p.is_active === 1 && p.show_on_register === 1).length;
  const newSellable = toCreate.filter((i) => i.sellable).length;
  const expectedTiles = preTiles - hide.length + newSellable;
  await checkRegisterAppearance(c, "11", expectedTiles, `tiles = ${preTiles} existing − ${hide.length} hidden + ${newSellable} new sellable`);
  save();
}

const c = await connect(PORT);
try {
  if (PHASE === "fresh") await phaseFresh(c);
  else if (PHASE === "restart") await phaseRestart(c);
  else if (PHASE === "exist") await phaseExist(c);
  else throw new Error(`unknown phase ${PHASE}`);
} catch (e) {
  check(`phase ${PHASE} completed`, false, e.message);
} finally {
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(`${OUT}/results-${PHASE}.json`, JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  c.close();
  process.exit(failed ? 1 : 0);
}
