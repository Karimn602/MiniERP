// V1.1 — BOUNDED SCALE / STRESS RUN (founder decision 7). OPT-IN ONLY.
//
//   GREAZ_STRESS_DB=<new file path> GREAZ_STRESS_SALES=100000 \
//     cargo test --release stress::scale -- --ignored --nocapture
//
// Builds a NEW database at the given path (refusing any path that already
// exists or looks like a protected Greaz identity), through the real migration
// runner, then posts every sale through the real `post_sale` path — the same
// validation, VAT authority, costing and stock movement a till runs. Nothing
// here inserts a sale row by hand.
//
// What it cannot do, stated: `post_sale` stamps `posted_at` with NOW and a
// posted sale is immutable, so the history is "100,000 sales today" rather than
// a year of them. Every date-range report therefore scans the whole history,
// which is the WORST case for those queries, not a typical one.

use crate::catalog::save_product_with_pool;
use crate::posting::{open_write_pool, post_purchase_with_pool, post_sale_with_pool};
use crate::test_support::*;
use crate::tests::builders::*;
use std::time::{Duration, Instant};

fn pct(sorted: &[Duration], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[i].as_secs_f64() * 1000.0
}

async fn timed<F: std::future::Future<Output = T>, T>(label: &str, f: F) -> T {
    let t = Instant::now();
    let r = f.await;
    println!("STRESS query  {:<44} {:>9.1} ms", label, t.elapsed().as_secs_f64() * 1000.0);
    r
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "opt-in scale run; see the module header"]
async fn scale() {
    let path = std::path::PathBuf::from(
        std::env::var("GREAZ_STRESS_DB").expect("set GREAZ_STRESS_DB to a NEW file path"),
    );
    let sales: usize = std::env::var("GREAZ_STRESS_SALES").ok().and_then(|v| v.parse().ok()).unwrap_or(100_000);
    let products: usize = std::env::var("GREAZ_STRESS_PRODUCTS").ok().and_then(|v| v.parse().ok()).unwrap_or(2_000);
    assert!(!path.exists(), "refusing to touch an existing file: {}", path.display());
    let s = path.to_string_lossy().replace('\\', "/");
    assert!(
        !s.contains("/com.greazlb.pos/") && !s.contains("/com.greazlb.pos.training/"),
        "refusing a protected identity: {s}"
    );

    let pool = open_write_pool(&path).await.unwrap();
    sqlx::query("PRAGMA journal_mode=WAL").execute(&pool).await.unwrap();
    app_migrator().run(&pool).await.expect("migrations");

    // ---- Reference data ----
    sqlx::query(&format!(
        "INSERT INTO exchange_rates (id, store_id, effective_date, rate_lbp_per_usd, source)
         VALUES ('{RATE_ID}', '{STORE_ID}', date('now'), {RATE_LBP_PER_USD}, 'manual')"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "INSERT INTO shifts (id, store_id, opened_by_user_id, opening_cash_usd_cents, opening_cash_lbp, status)
         VALUES ('{SHIFT_ID}', '{STORE_ID}', '{USER_ID}', 10000, 0, 'open')"
    ))
    .execute(&pool)
    .await
    .unwrap();

    // ---- Catalogue: 2,000 items, 10% stocked (with an opening count), the
    //      rest menu services; every 4th one barcoded. ----
    let t = Instant::now();
    let mut ids = Vec::with_capacity(products);
    for i in 0..products {
        let id = uuid();
        let stocked = i % 10 == 0;
        let incl = 150 + (i as i64 % 40) * 25;
        let p = crate::catalog::SaveProductPayload {
            product_id: id.clone(),
            store_id: STORE_ID.to_string(),
            mode: "create".into(),
            sku: Some(format!("STRESS-{i:05}")),
            name: format!("Item {i:05} {}", ["Burger", "Wrap", "Fries", "Drink", "Salad"][i % 5]),
            description: None,
            vat_rate_id: VAT_STD_ID.into(),
            vat_pricing_mode: "inclusive".into(),
            price_excl_vat_cents: strip_vat(incl, VAT_STD_BPS),
            price_incl_vat_cents: incl,
            reorder_point: None,
            is_service: !stocked,
            is_active: true,
            category: None,
            icon: None,
            costing_method: if stocked { None } else { Some("standard".into()) },
            standard_cost_excl_vat_microcents: if stocked { None } else { Some(40_000_000) },
            show_on_register: None,
            allow_negative_stock: None,
            base_uom_code: "each".into(),
            sale_uom_code: "each".into(),
            sale_factor_num: 1,
            sale_factor_den: 1,
            sale_price_excl_vat_cents: None,
            sale_price_incl_vat_cents: None,
            barcode: if i % 4 == 0 { Some(format!("29{:011}", i)) } else { None },
            barcode_type: if i % 4 == 0 { Some("INTERNAL".into()) } else { None },
        };
        save_product_with_pool(&pool, p).await.expect("product");
        ids.push((id, incl, stocked));
    }
    println!("STRESS setup  {products} products in {:.1}s", t.elapsed().as_secs_f64());
    // Opening stock for the stocked tenth, 50 lines a document.
    let stocked: Vec<_> = ids.iter().filter(|p| p.2).collect();
    for chunk in stocked.chunks(50) {
        let lines = chunk
            .iter()
            .map(|(id, _, _)| PurchaseLineBuilder::new(id, "stock").qty(1_000_000).unit_cost_excl(100).build())
            .collect();
        post_purchase_with_pool(&pool, purchase_payload("opening", None, lines)).await.expect("opening");
    }

    // ---- Sales: N x 3 lines, real post_sale ----
    let mut lat = Vec::with_capacity(sales);
    let started = Instant::now();
    for n in 0..sales {
        let pick = |k: usize| &ids[(n * 7 + k * 131) % ids.len()];
        let mut lines = Vec::with_capacity(3);
        let mut total = 0;
        for k in 0..3 {
            let (id, incl, stocked) = pick(k);
            let qty = 1 + ((n + k) % 3) as i64;
            lines.push(
                SaleLineBuilder::new(id, "line")
                    .qty(qty)
                    .unit_incl(*incl)
                    .service(!*stocked)
                    .build(),
            );
            total += incl * qty;
        }
        let pay = if n % 4 == 0 {
            cash_lbp((total * RATE_LBP_PER_USD + 99) / 100)
        } else {
            cash_usd(total)
        };
        let payload = sale_payload(lines, vec![pay]);
        let t = Instant::now();
        post_sale_with_pool(&pool, payload)
            .await
            .unwrap_or_else(|e| panic!("sale {n} refused: {e}"));
        lat.push(t.elapsed());
        if (n + 1) % 10_000 == 0 {
            let mut w: Vec<_> = lat[lat.len() - 10_000..].to_vec();
            w.sort();
            println!(
                "STRESS post   {:>7} sales  window p50 {:>6.2} ms  p95 {:>6.2} ms  max {:>7.2} ms  elapsed {:>6.1}s",
                n + 1,
                pct(&w, 0.5),
                pct(&w, 0.95),
                pct(&w, 1.0),
                started.elapsed().as_secs_f64()
            );
        }
    }
    lat.sort();
    println!(
        "STRESS post   TOTAL {sales} sales in {:.1}s  p50 {:.2} ms  p95 {:.2} ms  p99 {:.2} ms  max {:.2} ms",
        started.elapsed().as_secs_f64(),
        pct(&lat, 0.5),
        pct(&lat, 0.95),
        pct(&lat, 0.99),
        pct(&lat, 1.0)
    );

    // ---- The read side, as the screens ask it ----
    let q = |sql: &'static str| sqlx::query(sql);
    timed("product search LIKE '%Burger%' (Products/Picker)", q(
        "SELECT id FROM products WHERE store_id = '00000000-0000-0000-0000-000000000001'
           AND is_active = 1 AND (name LIKE '%Burger%' OR sku LIKE '%Burger%') ORDER BY name LIMIT 200",
    ).fetch_all(&pool)).await.unwrap();
    timed("barcode scan lookup", q(
        "SELECT product_id FROM product_barcodes WHERE store_id = '00000000-0000-0000-0000-000000000001'
           AND lookup_value = '2900000001996' AND is_active = 1",
    ).fetch_all(&pool)).await.unwrap();
    timed("dailySales (whole history)", q(
        "SELECT date(posted_at,'localtime') d, COUNT(*), SUM(total_incl_vat_cents), SUM(cogs_total_cents)
           FROM sales WHERE store_id = '00000000-0000-0000-0000-000000000001' AND status = 'posted'
            AND posted_at >= '2000-01-01' AND posted_at <= '2999-01-01' GROUP BY d",
    ).fetch_all(&pool)).await.unwrap();
    timed("productSales (whole history)", q(
        "SELECT si.product_id, SUM(si.quantity), SUM(si.line_total_incl_vat_cents), SUM(si.line_cogs_excl_vat_cents)
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.store_id = '00000000-0000-0000-0000-000000000001' AND s.status = 'posted'
            AND s.posted_at >= '2000-01-01' AND s.posted_at <= '2999-01-01'
          GROUP BY si.product_id, si.product_name_snapshot, si.product_sku_snapshot
          ORDER BY 3 DESC",
    ).fetch_all(&pool)).await.unwrap();
    timed("shift sales summary (one 100k-sale shift)", q(
        "SELECT COUNT(*), SUM(total_incl_vat_cents) FROM sales
          WHERE store_id = '00000000-0000-0000-0000-000000000001'
            AND shift_id = '00000000-0000-0000-0000-00000000f001' AND status = 'posted'",
    ).fetch_all(&pool)).await.unwrap();
    timed("Sales History first page (200 newest)", q(
        "SELECT id, receipt_number, total_incl_vat_cents FROM sales
          WHERE store_id = '00000000-0000-0000-0000-000000000001' AND status = 'posted'
          ORDER BY posted_at DESC LIMIT 200",
    ).fetch_all(&pool)).await.unwrap();
    timed("receipt lookup by number (Returns)", q(
        "SELECT id FROM sales WHERE store_id = '00000000-0000-0000-0000-000000000001'
           AND receipt_number = 54321 AND status = 'posted' LIMIT 1",
    ).fetch_all(&pool)).await.unwrap();

    // ---- Integrity ----
    let ic: String = timed("PRAGMA integrity_check", sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&pool)).await.unwrap();
    println!("STRESS integrity_check = {ic}");
    assert_eq!(ic, "ok");
    let fk: Vec<sqlx::sqlite::SqliteRow> = sqlx::query("PRAGMA foreign_key_check").fetch_all(&pool).await.unwrap();
    println!("STRESS foreign_key_check rows = {}", fk.len());
    assert!(fk.is_empty());
    let (n_sales, n_lines): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM sales), (SELECT COUNT(*) FROM sale_items)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    println!("STRESS rows   sales {n_sales}  sale_items {n_lines}");
    // Every stocked product's ledger still reconciles to its quantity.
    let drift: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM products p
          WHERE p.is_service = 0 AND p.quantity_on_hand <>
                (SELECT COALESCE(SUM(quantity_delta),0) FROM inventory_movements m WHERE m.product_id = p.id)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    println!("STRESS stock-ledger drift rows = {drift}");
    assert_eq!(drift, 0);
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&pool).await.unwrap();
    pool.close().await;
    println!("STRESS file   {} bytes", std::fs::metadata(&path).unwrap().len());
}
