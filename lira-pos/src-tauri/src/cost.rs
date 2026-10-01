// src-tauri/src/cost.rs
//
// The one place that defines how a UNIT COST is represented, scaled, combined
// and rounded. Everything that touches cost — `post_purchase`, `post_sale`,
// `post_adjustment` — goes through this module, so Rust and TypeScript cannot
// drift apart on scale or rounding (`src/lib/cost.ts` is the mirror).
//
// ---------------------------------------------------------------------------
// WHY A SECOND SCALE EXISTS AT ALL
// ---------------------------------------------------------------------------
//
// Transaction MONEY — line subtotals, VAT, totals, tender, COGS amounts, the
// supplier ledger — stays exact INTEGER USD CENTS. A cent is the smallest
// amount that can be invoiced, paid or banked, so rounding money to cents is
// not a loss of information: it *is* the information.
//
// A UNIT COST is not money. It is a RATE: money per base unit. When the
// purchasing UoM is much larger than the stocking/base UoM, that rate is
// legitimately smaller than one cent:
//
//     flour bought at $2.50 / kg, stocked in grams  ->  $0.0025 / g
//     oil   bought at $3.00 / L,  consumed in ml    ->  $0.0030 / ml
//
// Held in whole cents, both collapse to 0, every gram costs nothing, COGS is
// zero and gross margin is fiction (GP-A03). So unit cost — and ONLY unit cost
// — carries a finer fixed-point scale.
//
// ---------------------------------------------------------------------------
// THE REPRESENTATION
// ---------------------------------------------------------------------------
//
//     1 cent = COST_SCALE microcents (1_000_000)
//     1 microcent = 1e-6 cents = 1e-8 USD
//
// Unit cost is a signed i64 count of microcents. That is six decimal places of
// a cent, eight of a dollar. For comparison, the finest rate this application
// can plausibly meet — bulk water at $0.20 per 1,000 L consumed in ml, i.e.
// $0.00000002 / ml — is still 2 microcents, so it survives as a non-zero
// value. At the other end, i64 microcents reaches
//
//     i64::MAX / COST_SCALE = 9,223,372,036,854 cents ~ $92.2 billion
//
// per base unit, and the weighted-average guard below holds the whole
// inventory VALUE to that same ceiling. Both bounds are far outside anything a
// Lebanese retailer or restaurant can reach, and crossing either one ERRORS
// rather than wrapping.
//
// ---------------------------------------------------------------------------
// ROUNDING
// ---------------------------------------------------------------------------
//
// Exactly one rounding rule is used anywhere cost is involved: HALF AWAY FROM
// ZERO, applied by `div_round_half_away` and nothing else. It matches the
// rounding the money layer already uses (`lib/money.ts` is built on
// `Math.round`, which is half away from zero) and the `(v + q/2) / q` idiom
// this file replaces.
//
// Intermediates are i128 so a product of two i64 values cannot wrap before it
// is divided back down; every narrowing back to i64 is checked.

/// Microcents per cent. The only cost-scale constant in the codebase; its
/// TypeScript twin is `COST_SCALE` in `src/lib/cost.ts`.
pub const COST_SCALE: i64 = 1_000_000;

const COST_SCALE_I128: i128 = COST_SCALE as i128;

/// `numerator / denominator`, rounded half away from zero.
///
/// The central rounding helper: every cost boundary in the application — cents
/// from microcents, microcents from a UoM conversion, a weighted average, an
/// extended line cost — is this function with different arguments. Keeping it
/// in one place is what makes "the rounding rule" a single, testable decision
/// rather than a convention repeated at each call site.
///
/// `denominator` must be positive; a non-positive one is a programming error in
/// the caller and is reported as such rather than silently producing a sign
/// flip.
pub fn div_round_half_away(numerator: i128, denominator: i128) -> Result<i128, String> {
    if denominator <= 0 {
        return Err(format!(
            "cost division requires a positive divisor, got {denominator}"
        ));
    }
    let half = denominator / 2;
    let adjusted = if numerator >= 0 {
        numerator.checked_add(half)
    } else {
        numerator.checked_sub(half)
    }
    .ok_or_else(|| "cost rounding overflows".to_string())?;
    // Rust integer division truncates toward zero, which is what the
    // half-away-from-zero adjustment above assumes.
    Ok(adjusted / denominator)
}

/// Narrow a wide intermediate back to the i64 a database column holds.
fn to_i64(value: i128, what: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("{what} is out of range ({value})"))
}

/// Exact: a whole-cent cost expressed in microcents. The migration's backfill
/// is this same multiplication, which is why pre-WP-03 cost data converts
/// without losing or inventing a fraction.
///
/// No posting path needs it — they all start from a per-UoM cost and go straight
/// to a per-base rate — but it is the documented inverse of
/// `microcents_to_cents`, and the migration tests use it to state the backfill
/// rule independently of the migration's own SQL. Hence the attribute.
#[allow(dead_code)]
pub fn cents_to_microcents(cents: i64) -> Result<i64, String> {
    let scaled = (cents as i128)
        .checked_mul(COST_SCALE_I128)
        .ok_or_else(|| format!("cost of {cents} cents is out of range in microcents"))?;
    to_i64(scaled, "cost in microcents")
}

/// Lossy by design: a microcent cost rounded to the nearest whole cent.
///
/// This is a PRESENTATION / compatibility conversion. It is used to maintain
/// the legacy `*_cents` cost columns beside their microcent counterparts, and
/// never to feed another cost calculation — doing that is exactly the early
/// rounding GP-A03 is about.
pub fn microcents_to_cents(microcents: i64) -> Result<i64, String> {
    let cents = div_round_half_away(microcents as i128, COST_SCALE_I128)?;
    to_i64(cents, "cost in cents")
}

/// Per-base-unit cost, in microcents, of something priced per purchasing UoM.
///
/// ```text
/// base cost = cost per UoM * den / num          (1 UoM = num/den base units)
/// ```
///
/// The whole point of GP-A03: the division happens ONCE, at microcent scale,
/// and is never preceded by a rounding to cents. `$2.50/kg` with a gram base
/// (num=1000, den=1) gives 250,000 microcents — $0.0025/g — where the old
/// cents-only conversion gave 0.
pub fn unit_cost_in_uom_to_base_microcents(
    cost_per_uom_cents: i64,
    factor_num: i64,
    factor_den: i64,
) -> Result<i64, String> {
    if factor_num <= 0 || factor_den <= 0 {
        return Err(format!(
            "UoM conversion factor must be positive, got {factor_num}/{factor_den}"
        ));
    }
    let numerator = (cost_per_uom_cents as i128)
        .checked_mul(COST_SCALE_I128)
        .and_then(|v| v.checked_mul(factor_den as i128))
        .ok_or_else(|| {
            format!(
                "unit cost {cost_per_uom_cents} cents x {factor_den} overflows at microcent scale"
            )
        })?;
    let microcents = div_round_half_away(numerator, factor_num as i128)?;
    to_i64(microcents, "per-base unit cost in microcents")
}

/// THE monetary rounding boundary for cost.
///
/// ```text
/// extended cost in cents = round(unit cost in microcents * quantity / COST_SCALE)
/// ```
///
/// Multiply first at full precision, round once at the end. This is the only
/// place a cost becomes money, and the reason a 500 g sale of $0.0025/g flour
/// books $1.25 of COGS instead of the $0.00 that rounding the unit cost first
/// would produce.
pub fn extended_cost_cents(unit_cost_microcents: i64, quantity: i64) -> Result<i64, String> {
    let total = (unit_cost_microcents as i128)
        .checked_mul(quantity as i128)
        .ok_or_else(|| {
            format!("extended cost of {quantity} x {unit_cost_microcents} microcents overflows")
        })?;
    let cents = div_round_half_away(total, COST_SCALE_I128)?;
    to_i64(cents, "extended cost in cents")
}

/// Weighted-average unit cost after receiving stock, in microcents.
///
/// ```text
/// new value   = old qty * old average + incoming qty * incoming cost
/// new average = new value / resulting quantity
/// ```
///
/// Both inventory values are accumulated at FULL microcent precision in i128
/// and divided once. No component is rounded to cents on the way, which is
/// what keeps the average sound when the unit costs involved are themselves
/// fractions of a cent.
///
/// Two boundaries are enforced rather than wrapped:
///
///   * the resulting quantity must be positive — a purchase cannot leave an
///     empty or negative pool to average over (unchanged policy);
///   * the total inventory VALUE must be representable in i64 microcents
///     (~ $92.2 billion). i128 is the wide intermediate used to *detect* that,
///     so an unrealistic value errors instead of silently wrapping.
pub fn new_weighted_avg(
    old_qty: i64,
    old_avg_microcents: i64,
    new_qty: i64,
    new_cost_microcents: i64,
) -> Result<i64, String> {
    let total_qty = (old_qty as i128)
        .checked_add(new_qty as i128)
        .ok_or_else(|| "weighted-avg quantity overflow".to_string())?;
    if total_qty <= 0 {
        return Err("total quantity must be positive after purchase".into());
    }
    let incoming_value = (new_qty as i128)
        .checked_mul(new_cost_microcents as i128)
        .ok_or_else(|| "weighted-avg overflow".to_string())?;
    let total_value = (old_qty as i128)
        .checked_mul(old_avg_microcents as i128)
        .and_then(|v| v.checked_add(incoming_value))
        .ok_or_else(|| "weighted-avg overflow".to_string())?;
    // The pool's value itself must stay representable, not just the average it
    // divides down to.
    to_i64(total_value, "inventory value in microcents")
        .map_err(|_| "weighted-avg overflow".to_string())?;
    let average = div_round_half_away(total_value, total_qty)?;
    to_i64(average, "weighted-average unit cost in microcents")
}
