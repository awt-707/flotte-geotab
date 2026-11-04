// Signed provider components, in integer minor units. This is a named business
// definition, not taxable turnover or a bank balance.
const COMPONENTS = ['fare', 'commission', 'taxes', 'tips', 'bonus'];
const LABELS = {fare: ['Fare'], commission: ['Service Fee'], taxes: ['Taxes'], tips: ['Tip', 'Tips'], bonus: ['Promotion', 'Promotions']};
const integer = value => Number.isSafeInteger(value);
const total = values => {
  const sum = values.reduce((value, next) => value + BigInt(next), 0n);
  return sum <= BigInt(Number.MAX_SAFE_INTEGER) && sum >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(sum) : null;
};

/** A complete immediate-child breakdown must have been read from the normal
 * expanded Total earnings UI. Missing optional categories mean zero only in
 * that exhaustive list; an unknown category disables both calculations. */
export function calculateUberEarnings(amounts, breakdown) {
  const unchanged = reason => ({amounts: {...amounts}, provenance: breakdown ? {version: 1, status: 'unavailable', reason} : null});
  if (!breakdown) return unchanged('missing_breakdown');
  if (breakdown.complete !== true || !Array.isArray(breakdown.entries) || !breakdown.entries.length || breakdown.entries.length > 30) return unchanged('incomplete_breakdown');
  const entries = [], seen = new Set();
  for (const entry of breakdown.entries) {
    if (!entry || !COMPONENTS.includes(entry.field) || !LABELS[entry.field].includes(entry.label)) return unchanged('unknown_component');
    if (seen.has(entry.field) || !integer(entry.minor)) return unchanged('invalid_component');
    seen.add(entry.field); entries.push({field: entry.field, label: entry.label, minor: entry.minor});
    const observed = amounts[entry.field + '_minor'];
    if (observed !== null && observed !== undefined && observed !== entry.minor) return unchanged('conflicting_component');
  }
  // Fare establishes the scope. Never use only fee/bonus rows as full income.
  if (!seen.has('fare') || !integer(amounts.revenue_minor)) return unchanged('incomplete_breakdown');
  const component = key => entries.find(entry => entry.field === key)?.minor ?? 0;
  // An omitted category is zero only if no other observed value contradicts
  // that exhaustive breakdown. Never erase a known tip/fee/tax/promotion.
  for (const key of COMPONENTS) {
    const observed = amounts[key + '_minor'];
    if (observed !== null && observed !== undefined && observed !== component(key)) return unchanged('conflicting_component');
  }
  const reconciled = total(entries.map(entry => entry.minor));
  if (reconciled === null || reconciled !== amounts.revenue_minor) return unchanged('total_mismatch');
  const gross = total(['fare', 'tips', 'bonus'].map(component));
  const net = total([gross ?? 0, component('commission')]);
  if (gross === null || net === null) return unchanged('amount_overflow');
  if (amounts.gross_minor !== null && amounts.gross_minor !== undefined && amounts.gross_minor !== gross ||
      amounts.net_minor !== null && amounts.net_minor !== undefined && amounts.net_minor !== net) return unchanged('conflicting_reported_amount');
  const result = {...amounts, gross_minor: gross, net_minor: net};
  for (const key of COMPONENTS) result[key + '_minor'] = component(key);
  return {amounts: result, provenance: {version: 1, status: 'verified', basis: 'visible_total_earnings_breakdown',
    gross_definition: 'before_uber_fees_and_provider_taxes', net_definition: 'after_uber_fees_before_provider_taxes',
    formula: 'fare_plus_tips_plus_bonus', reconciliation: 'exact', total_minor: reconciled, entries}};
}

export function validUberEarningsProvenance(amounts, provenance) {
  if (provenance == null) return true;
  if (provenance.version !== 1) return false;
  if (provenance.status === 'unavailable') return ['missing_breakdown','incomplete_breakdown','unknown_component','invalid_component',
    'conflicting_component','total_mismatch','amount_overflow','conflicting_reported_amount'].includes(provenance.reason) && Object.keys(provenance).length === 3;
  const calculated = calculateUberEarnings({...amounts, gross_minor: null, net_minor: null}, {complete: true, entries: provenance.entries});
  return calculated.provenance?.status === 'verified' && Object.keys(calculated.provenance).length === Object.keys(provenance).length && Object.entries(calculated.provenance).every(([key,value])=>key==='entries'?Array.isArray(provenance.entries)&&value.length===provenance.entries.length&&value.every((entry,i)=>Object.keys(provenance.entries[i]).length===3&&['field','label','minor'].every(k=>entry[k]===provenance.entries[i][k])):value===provenance[key]) &&
    ['gross_minor','net_minor',...COMPONENTS.map(key => key + '_minor')].every(key => amounts[key] === calculated.amounts[key]);
}
