export interface Pax8PricingRate {
  partnerBuyRate?: unknown;
  suggestedRetailPrice?: unknown;
  startQuantityRange?: unknown;
  endQuantityRange?: unknown;
  chargeType?: unknown;
  [key: string]: unknown;
}

export interface Pax8PricingTerm {
  billingTerm?: unknown;
  type?: unknown;
  unitOfMeasurement?: unknown;
  rates?: unknown;
  currencyCode?: unknown;
  currency?: unknown;
  [key: string]: unknown;
}

export interface Pax8ResolvedPricing {
  partnerBuyRate: number;
  suggestedRetailPrice: number | null;
  billingTerm: string | null;
  unitOfMeasurement: string | null;
  chargeType: string | null;
  currencyCode: string | null;
  zeroRatePricing: boolean;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeTerm(value: unknown): string {
  return text(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '') ?? '';
}

function pricingTerms(pricing: unknown): Pax8PricingTerm[] {
  if (Array.isArray(pricing)) return pricing as Pax8PricingTerm[];
  if (!pricing || typeof pricing !== 'object') return [];
  const content = (pricing as { content?: unknown }).content;
  return Array.isArray(content) ? content as Pax8PricingTerm[] : [];
}

function termCurrency(term: Pax8PricingTerm): string | null {
  const direct = text(term.currencyCode) ?? text(term.currency);
  if (direct) return direct.toUpperCase();
  return null;
}

/**
 * Resolve the current partner buy rate returned by Pax8's dynamic product
 * pricing endpoint for one subscription quantity.
 *
 * The endpoint can return multiple billing terms and quantity tiers. We only
 * return a rate when a billing term can be selected safely and the quantity is
 * covered by an explicit rate tier. Callers should treat null as unresolved
 * rather than guessing a price.
 */
export function resolvePax8PartnerPricing(
  pricing: unknown,
  billingTerms: string[],
  quantity: number,
): Pax8ResolvedPricing | null {
  if (!Number.isFinite(quantity) || quantity < 0) return null;

  const terms = pricingTerms(pricing);
  if (terms.length === 0) return null;

  const requestedTerms = new Set(
    billingTerms.map(normalizeTerm).filter(Boolean),
  );

  let selectedTerm: Pax8PricingTerm | undefined;
  if (requestedTerms.size > 0) {
    selectedTerm = terms.find((term) => requestedTerms.has(normalizeTerm(term.billingTerm)));
  }

  // A single returned term is unambiguous even when the subscription snapshot
  // did not include billing-term metadata. Never pick arbitrarily from multiple
  // unmatched terms.
  if (!selectedTerm && terms.length === 1) selectedTerm = terms[0];
  if (!selectedTerm) return null;

  const rates = Array.isArray(selectedTerm.rates)
    ? (selectedTerm.rates as Pax8PricingRate[])
    : [];

  const eligible = rates
    .map((rate) => ({
      rate,
      buyRate: finiteNumber(rate.partnerBuyRate),
      start: finiteNumber(rate.startQuantityRange) ?? 0,
      end: finiteNumber(rate.endQuantityRange),
    }))
    .filter((entry) => (
      entry.buyRate !== null
      && quantity >= entry.start
      && (entry.end === null || quantity <= entry.end)
    ))
    .sort((left, right) => right.start - left.start);

  const selectedRate = eligible[0];
  if (!selectedRate || selectedRate.buyRate === null) return null;

  const suggestedRetailPrice = finiteNumber(selectedRate.rate.suggestedRetailPrice);

  return {
    partnerBuyRate: selectedRate.buyRate,
    suggestedRetailPrice,
    billingTerm: text(selectedTerm.billingTerm),
    unitOfMeasurement: text(selectedTerm.unitOfMeasurement),
    chargeType: text(selectedRate.rate.chargeType),
    currencyCode: termCurrency(selectedTerm),
    zeroRatePricing: selectedRate.buyRate === 0 && suggestedRetailPrice === 0,
  };
}
