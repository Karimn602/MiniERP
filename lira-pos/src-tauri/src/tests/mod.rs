// WP-01 Rust test suite.
//
// Layer B — pure unit tests:            `pure`, `cost`
// Layer C — SQLite posting integration: everything else
//
// Every integration test builds its own temporary database via
// `test_support::TempDb`. See tests/README.md for the full map.

mod builders;

mod adjustments;
mod catalog;
mod cost;
mod cost_precision;
mod demo_menu;
mod drivers;
mod hardening;
mod immutability;
mod known_defects;
mod lifecycle;
mod migrations;
mod purchase_authority;
mod purchases;
mod pure;
mod recipe_sale_costing;
mod recipes;
mod reconciliation;
mod returns;
mod sales;
mod shifts;
mod standard_cost;
mod supplier_ap;
mod supplier_payments;
mod tenders;
