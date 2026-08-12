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
/** Minimum evidence a protocell is a real, self-sustaining Darwinian unit —
 * not just a bag that happened to trap some chemistry once: it needs an
 * active catalyst supporting replication, it needs to have actually
 * completed a full templated copy at least once, and it needs to have
 * survived a fission event with a replicator still inside afterward
 * (otherwise a lucky one-off capture doesn't mean anything heritable). */
export function isBootstrapEligible(v, hasActiveCatalyst, hasReplicatorNow) {
    return hasActiveCatalyst && hasReplicatorNow && v.replicationEvents >= 2 && v.divisions >= 1;
}
