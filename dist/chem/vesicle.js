// A 2D "ring" abstraction: lipids spaced LIPID_SPACING apart around the
// circumference, so radius = circumference / 2π = (count * spacing) / 2π.
export const LIPID_SPACING = 2.6;
export function radiusForLipidCount(count) {
    return Math.max(6, (count * LIPID_SPACING) / (2 * Math.PI));
}
export const MIN_VESICLE_LIPIDS = 10;
// Calibrated against the actual lipid economy, not picked in the abstract:
// a fixed pool of ~160-220 lipids split across the several vesicles that
// typically coexist in a run settles out to roughly 10-25 lipids each
// (headless-verified) — a 40-lipid bar meant *no* vesicle could ever
// plausibly reach it, which meant division (and therefore bootstrap,
// which requires at least one) was structurally unreachable no matter how
// long a run went. 22 sits just above 2x the viable-daughter minimum, so
// a division actually happens once a vesicle's had a real growth
// advantage, without requiring it to hoard nearly the whole dish's lipid
// supply first.
export const DIVISION_LIPID_COUNT = 22;
// A membrane can end up structurally locked out of ever dividing again if it
// keeps absorbing other vesicles faster than divisionCooldownTicks ever
// clears — mergeVesicles() (origin.ts) resets the cooldown clock on every
// fusion (see its own comment: an unprotected freshly-fused vesicle
// instantly re-splits and undoes the merge before any chemistry happens),
// but at high soup density a vesicle whose radius has grown into a large
// fraction of the pool stays in near-constant contact with newly-forming
// small vesicles, so it can accumulate fusions — and cooldown resets —
// faster than 500 ticks ever elapses between two of them. Headless-verified
// as a real runaway at 8x soup density, not a hypothetical: 6 of 8 seeds in
// a 15,000-tick sweep collapsed to a single vesicle holding 1,700-1,900+ of
// ~1,920 total pool lipids, some still collapsed tens of thousands of ticks
// later in a longer run.
//
// Past some point the "let a freshly-joined membrane settle" rationale the
// cooldown exists for no longer applies: a vesicle this far past
// DIVISION_LIPID_COUNT isn't freshly formed in any meaningful sense, it's
// overdue for fission regardless of how recently it last touched another
// vesicle. 3x is calibrated against real numbers, not picked in the
// abstract: the healthy multi-vesicle equilibrium at 8x soup density
// settles to roughly 18 lipids/vesicle on average (106 vesicles sharing
// ~1,920 total pool lipids — see seedPrimordialSoup's own comment), and
// even a freshly-fused pair of ordinary vesicles (the exact case
// divisionCooldownTicks protects) tops out around 30-50 combined — both
// comfortably under 66. The actual runaway collapse this constant targets
// reached 1,700-1,900+ lipids in a single vesicle (roughly 77-86x this bar)
// in headless verification — nowhere near this threshold by accident.
export const OVERSIZE_DIVISION_MULTIPLIER = 3;
/** Minimum evidence a protocell is a real, self-sustaining Darwinian unit —
 * not just a bag that happened to trap some chemistry once: it needs an
 * active catalyst supporting replication, it needs to have actually
 * completed a full templated copy at least once, and it needs to have
 * survived a fission event with a replicator still inside afterward
 * (otherwise a lucky one-off capture doesn't mean anything heritable). */
export function isBootstrapEligible(v, hasActiveCatalyst, hasReplicatorNow) {
    return hasActiveCatalyst && hasReplicatorNow && v.replicationEvents >= 2 && v.divisions >= 1;
}
