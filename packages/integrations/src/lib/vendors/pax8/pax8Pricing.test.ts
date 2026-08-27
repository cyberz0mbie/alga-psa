import { describe, expect, it } from 'vitest';
import { resolvePax8PartnerPricing } from './pax8Pricing';

describe('resolvePax8PartnerPricing', () => {
  it('matches the subscription billing term and quantity tier', () => {
    const result = resolvePax8PartnerPricing({
      content: [
        {
          billingTerm: 'Monthly',
          unitOfMeasurement: 'Each',
          rates: [
            {
              partnerBuyRate: 12,
              suggestedRetailPrice: 16,
              startQuantityRange: 0,
              endQuantityRange: 9,
              chargeType: 'Per Unit',
            },
            {
              partnerBuyRate: 10,
              suggestedRetailPrice: 15,
              startQuantityRange: 10,
              chargeType: 'Per Unit',
            },
          ],
        },
        {
          billingTerm: 'Annual',
          rates: [{ partnerBuyRate: 100, startQuantityRange: 0 }],
        },
      ],
    }, ['Monthly'], 12);

    expect(result).toMatchObject({
      partnerBuyRate: 10,
      suggestedRetailPrice: 15,
      billingTerm: 'Monthly',
      unitOfMeasurement: 'Each',
      chargeType: 'Per Unit',
      zeroRatePricing: false,
    });
  });

  it('does not guess when multiple pricing terms are returned without a matching term', () => {
    const result = resolvePax8PartnerPricing({
      content: [
        { billingTerm: 'Monthly', rates: [{ partnerBuyRate: 10, startQuantityRange: 0 }] },
        { billingTerm: 'Annual', rates: [{ partnerBuyRate: 100, startQuantityRange: 0 }] },
      ],
    }, ['3-Year'], 1);

    expect(result).toBeNull();
  });

  it('flags zero-rate pricing for usage/promo review', () => {
    const result = resolvePax8PartnerPricing({
      content: [{
        billingTerm: 'Monthly',
        unitOfMeasurement: 'Each',
        rates: [{
          partnerBuyRate: 0,
          suggestedRetailPrice: 0,
          startQuantityRange: 0,
        }],
      }],
    }, ['Monthly'], 1);

    expect(result?.zeroRatePricing).toBe(true);
  });
});
