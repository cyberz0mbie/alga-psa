'use server';

import { withAuth } from '@alga-psa/auth';
import { hasPermission } from '@alga-psa/auth/rbac';
import { getSecretProviderInstance } from '@alga-psa/core/secrets';
import { createTenantKnex, tenantDb } from '@alga-psa/db';
import {
  listVendorClientMappings,
  listVendorIntegrations,
  listVendorServiceMappings,
} from '../../services/vendorIntegrationService';
import { Pax8ApiClient } from '../../lib/vendors/pax8/pax8ApiClient';
import { resolvePax8PartnerPricing } from '../../lib/vendors/pax8/pax8Pricing';

const PROVIDER = 'pax8' as const;

export type Pax8CostPreviewStatus =
  | 'unmapped-client'
  | 'unmapped-service'
  | 'tracking-disabled'
  | 'no-contract-service'
  | 'ambiguous-contract'
  | 'pricing-unresolved'
  | 'zero-rate-review'
  | 'ready';

export interface Pax8CostPreviewRow {
  externalClientId: string;
  externalClientName: string;
  externalProductId: string;
  externalProductName: string;
  externalSku?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  serviceId?: string | null;
  serviceName?: string | null;
  quantity: number;
  billingTerms: string[];
  contractLineName?: string | null;
  contractCurrency?: string | null;
  pax8PartnerBuyRate?: number | null;
  pax8SuggestedRetailPrice?: number | null;
  pax8Currency?: string | null;
  pax8BillingTerm?: string | null;
  pax8UnitOfMeasurement?: string | null;
  algaCatalogCostCents?: number | null;
  algaCatalogCostCurrency?: string | null;
  algaSellRateCents?: number | null;
  algaSellRateCurrency?: string | null;
  algaSellRateSource?: 'contract' | 'catalog' | null;
  marginPerUnitCents?: number | null;
  marginPercent?: number | null;
  currencyInferred: boolean;
  status: Pax8CostPreviewStatus;
  detail?: string | null;
}

type ContractMatch = {
  client_id: string;
  service_id: string;
  contract_line_id: string;
  contract_line_name: string | null;
  currency_code: string | null;
  custom_rate: string | number | null;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotKey(externalClientId: string, externalProductId: string): string {
  return `${externalClientId}:${externalProductId}`;
}

function pairKey(clientId: string, serviceId: string): string {
  return `${clientId}:${serviceId}`;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
}

function clientIdSecretName(integrationId: string): string {
  return `vendor_pax8_${integrationId}_client_id`;
}

function clientSecretSecretName(integrationId: string): string {
  return `vendor_pax8_${integrationId}_client_secret`;
}

async function buildConfiguredPax8Client(tenant: string, integrationId: string): Promise<Pax8ApiClient> {
  const secretProvider = await getSecretProviderInstance();
  const [clientId, clientSecret] = await Promise.all([
    secretProvider.getTenantSecret(tenant, clientIdSecretName(integrationId)),
    secretProvider.getTenantSecret(tenant, clientSecretSecretName(integrationId)),
  ]);

  if (!clientId || !clientSecret) {
    throw new Error('Pax8 client ID and client secret are not configured');
  }

  return new Pax8ApiClient({ clientId, clientSecret });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()));
  return results;
}

export const getPax8CostPreview = withAuth(async (
  user,
  { tenant },
): Promise<{ success: boolean; error?: string; rows?: Pax8CostPreviewRow[] }> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'read');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex } = await createTenantKnex();
    const integrations = await listVendorIntegrations(knex, tenant);
    const integration = integrations.find((item) => item.provider === PROVIDER);
    if (!integration) return { success: true, rows: [] };

    const db = tenantDb(knex, tenant);
    const [clientMappings, serviceMappings, snapshots] = await Promise.all([
      listVendorClientMappings(knex, tenant, integration.integration_id),
      listVendorServiceMappings(knex, tenant, integration.integration_id),
      db.table('vendor_usage_snapshots')
        .where({ integration_id: integration.integration_id })
        .select('*')
        .orderBy('captured_at', 'desc'),
    ]);

    const latestSnapshots = new Map<string, any>();
    for (const snapshot of snapshots as any[]) {
      const key = snapshotKey(snapshot.external_client_id, snapshot.external_product_id);
      if (!latestSnapshots.has(key)) latestSnapshots.set(key, snapshot);
    }

    const clientMappingByExternal = new Map(
      clientMappings.map((mapping) => [mapping.external_client_id, mapping]),
    );
    const serviceMappingByExternal = new Map(
      serviceMappings.map((mapping) => [mapping.external_product_id, mapping]),
    );

    const mappedClientIds = Array.from(new Set(
      clientMappings
        .filter((mapping) => mapping.mapping_status === 'mapped' && mapping.client_id)
        .map((mapping) => mapping.client_id as string),
    ));
    const mappedServiceIds = Array.from(new Set(
      serviceMappings
        .filter((mapping) => mapping.mapping_status === 'mapped' && mapping.service_id)
        .map((mapping) => mapping.service_id as string),
    ));

    const [clients, services, servicePrices] = await Promise.all([
      mappedClientIds.length > 0
        ? db.table('clients').whereIn('client_id', mappedClientIds).select('client_id', 'client_name')
        : Promise.resolve([]),
      mappedServiceIds.length > 0
        ? db.table('service_catalog')
            .whereIn('service_id', mappedServiceIds)
            .select('service_id', 'service_name', 'default_rate', 'cost', 'cost_currency')
        : Promise.resolve([]),
      mappedServiceIds.length > 0
        ? db.table('service_prices')
            .whereIn('service_id', mappedServiceIds)
            .select('service_id', 'currency_code', 'rate')
        : Promise.resolve([]),
    ]);

    const clientNameById = new Map((clients as any[]).map((client) => [client.client_id, client.client_name]));
    const serviceById = new Map((services as any[]).map((service) => [service.service_id, service]));
    const priceByServiceCurrency = new Map(
      (servicePrices as any[]).map((price) => [`${price.service_id}:${String(price.currency_code).toUpperCase()}`, price]),
    );

    const contractMatchesByPair = new Map<string, ContractMatch[]>();
    if (mappedClientIds.length > 0 && mappedServiceIds.length > 0) {
      const now = new Date().toISOString();
      const query = db.table('client_contracts as cc');
      db.tenantJoin(query, 'contracts as co', 'cc.contract_id', 'co.contract_id');
      db.tenantJoin(query, 'contract_lines as cl', 'cl.contract_id', 'cc.contract_id');
      db.tenantJoin(
        query,
        'contract_line_service_configuration as cfg',
        'cfg.contract_line_id',
        'cl.contract_line_id',
        { rootTenantColumn: 'cc.tenant' },
      );

      const matches = await query
        .whereIn('cc.client_id', mappedClientIds)
        .whereIn('cfg.service_id', mappedServiceIds)
        .where('cc.is_active', true)
        .where('co.status', 'active')
        .andWhere((builder) => builder.whereNull('cc.start_date').orWhere('cc.start_date', '<=', now))
        .andWhere((builder) => builder.whereNull('cc.end_date').orWhere('cc.end_date', '>=', now))
        .select(
          'cc.client_id',
          'cfg.service_id',
          'cl.contract_line_id',
          'cl.contract_line_name',
          'co.currency_code',
          'cfg.custom_rate',
        ) as unknown as ContractMatch[];

      for (const match of matches) {
        const key = pairKey(match.client_id, match.service_id);
        const values = contractMatchesByPair.get(key) ?? [];
        values.push(match);
        contractMatchesByPair.set(key, values);
      }
    }

    const pax8Client = await buildConfiguredPax8Client(tenant, integration.integration_id);
    const rowsToPrice = Array.from(latestSnapshots.values()).filter((snapshot) => {
      const mapping = serviceMappingByExternal.get(snapshot.external_product_id);
      return mapping?.mapping_status === 'mapped' && Boolean(mapping.service_id) && Boolean(mapping.sync_cost);
    });

    const rows = await mapWithConcurrency(rowsToPrice, 5, async (snapshot): Promise<Pax8CostPreviewRow> => {
      const clientMapping = clientMappingByExternal.get(snapshot.external_client_id);
      const serviceMapping = serviceMappingByExternal.get(snapshot.external_product_id);
      const clientMapped = clientMapping?.mapping_status === 'mapped' && Boolean(clientMapping.client_id);
      const serviceMapped = serviceMapping?.mapping_status === 'mapped' && Boolean(serviceMapping.service_id);
      const clientId = clientMapped ? clientMapping?.client_id ?? null : null;
      const serviceId = serviceMapped ? serviceMapping?.service_id ?? null : null;
      const service = serviceId ? serviceById.get(serviceId) : null;
      const matches = clientId && serviceId
        ? contractMatchesByPair.get(pairKey(clientId, serviceId)) ?? []
        : [];
      const quantity = finiteNumber(snapshot.quantity) ?? 0;
      const billingTerms = stringArray(snapshot.metadata?.billingTerms);

      const base: Pax8CostPreviewRow = {
        externalClientId: snapshot.external_client_id,
        externalClientName: clientMapping?.external_client_name ?? snapshot.external_client_id,
        externalProductId: snapshot.external_product_id,
        externalProductName: serviceMapping?.external_product_name ?? snapshot.external_product_id,
        externalSku: serviceMapping?.external_sku ?? null,
        clientId,
        clientName: clientId ? clientNameById.get(clientId) ?? null : null,
        serviceId,
        serviceName: service?.service_name ?? null,
        quantity,
        billingTerms,
        algaCatalogCostCents: finiteNumber(service?.cost),
        algaCatalogCostCurrency: service?.cost_currency ? String(service.cost_currency).toUpperCase() : null,
        currencyInferred: false,
        status: 'ready',
      };

      if (!clientMapped) return { ...base, status: 'unmapped-client', detail: 'Map this Pax8 customer first.' };
      if (!serviceMapped || !service) return { ...base, status: 'unmapped-service', detail: 'Map this Pax8 product first.' };
      if (!serviceMapping?.sync_cost) return { ...base, status: 'tracking-disabled', detail: 'Enable Cost tracking for this product.' };
      if (matches.length === 0) return { ...base, status: 'no-contract-service', detail: 'The mapped service is not on an active contract for this client.' };
      if (matches.length > 1) return { ...base, status: 'ambiguous-contract', detail: `${matches.length} active contract matches need review.` };

      const match = matches[0];
      const contractCurrency = match.currency_code ? String(match.currency_code).toUpperCase() : null;
      const customRate = finiteNumber(match.custom_rate);
      const catalogPrice = contractCurrency
        ? priceByServiceCurrency.get(`${serviceId}:${contractCurrency}`)
        : null;
      const catalogRate = finiteNumber(catalogPrice?.rate) ?? finiteNumber(service.default_rate);
      const sellRateCents = customRate ?? catalogRate;
      const sellRateSource = customRate !== null ? 'contract' as const : catalogRate !== null ? 'catalog' as const : null;

      let resolvedPricing;
      try {
        const pricing = await pax8Client.getProductPricing(snapshot.external_product_id, snapshot.external_client_id);
        resolvedPricing = resolvePax8PartnerPricing(pricing, billingTerms, quantity);
      } catch (pricingError) {
        return {
          ...base,
          contractLineName: match.contract_line_name,
          contractCurrency,
          algaSellRateCents: sellRateCents,
          algaSellRateCurrency: contractCurrency,
          algaSellRateSource: sellRateSource,
          status: 'pricing-unresolved',
          detail: errorMessage(pricingError),
        };
      }

      if (!resolvedPricing) {
        return {
          ...base,
          contractLineName: match.contract_line_name,
          contractCurrency,
          algaSellRateCents: sellRateCents,
          algaSellRateCurrency: contractCurrency,
          algaSellRateSource: sellRateSource,
          status: 'pricing-unresolved',
          detail: 'Pax8 pricing did not contain an unambiguous billing-term and quantity tier match.',
        };
      }

      const pax8Currency = resolvedPricing.currencyCode ?? contractCurrency;
      const currencyInferred = resolvedPricing.currencyCode == null && contractCurrency != null;
      const comparable = Boolean(
        sellRateCents !== null
        && pax8Currency
        && contractCurrency
        && pax8Currency === contractCurrency,
      );
      const partnerCostCents = resolvedPricing.partnerBuyRate * 100;
      const marginPerUnitCents = comparable && sellRateCents !== null
        ? sellRateCents - partnerCostCents
        : null;
      const marginPercent = marginPerUnitCents !== null && sellRateCents && sellRateCents !== 0
        ? (marginPerUnitCents / sellRateCents) * 100
        : null;

      return {
        ...base,
        contractLineName: match.contract_line_name,
        contractCurrency,
        pax8PartnerBuyRate: resolvedPricing.partnerBuyRate,
        pax8SuggestedRetailPrice: resolvedPricing.suggestedRetailPrice,
        pax8Currency,
        pax8BillingTerm: resolvedPricing.billingTerm,
        pax8UnitOfMeasurement: resolvedPricing.unitOfMeasurement,
        algaSellRateCents: sellRateCents,
        algaSellRateCurrency: contractCurrency,
        algaSellRateSource: sellRateSource,
        marginPerUnitCents,
        marginPercent,
        currencyInferred,
        status: resolvedPricing.zeroRatePricing ? 'zero-rate-review' : 'ready',
        detail: resolvedPricing.zeroRatePricing
          ? 'Pax8 returned a zero buy/retail rate. Review usage, trial, promo, or container pricing before relying on margin.'
          : currencyInferred
            ? 'Pax8 did not report a currency code; the contract currency is used for display/comparison.'
            : null,
      };
    });

    rows.sort((left, right) => (
      left.externalClientName.localeCompare(right.externalClientName)
      || left.externalProductName.localeCompare(right.externalProductName)
    ));

    return { success: true, rows };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});
