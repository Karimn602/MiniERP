// WP-01 Rust test suite.
//
// Layer B — pure unit tests:            `pure`
// Layer C — SQLite posting integration: everything else
//
// Every integration test builds its own temporary database via
// `test_support::TempDb`. See tests/README.md for the full map.

mod builders;

mod adjustments;
mod immutability;
mod known_defects;
mod migrations;
mod purchases;
mod pure;
mod reconciliation;
mod sales;
mod supplier_payments;
