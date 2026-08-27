'use server';

import { withAuth } from '@alga-psa/auth';
import { hasPermission } from '@alga-psa/auth/rbac';
import { createTenantKnex, tenantDb } from '@alga-psa/db';
import {
  listVendorClientMappings,
  listVendorIntegrations,
  listVendorServiceMappings,
} from '../../services/vendorIntegrationService';

const PROVIDER = 'pax8' as const;

export type Pax8ReconciliationStatus =
  | 'unmapped-client'
  | 'unmapped-service'
  | 'tracking-disabled'
  | 'no-contract-service'
  | 'ambiguous-contract'
  | 'ready';

export type Pax8ProposedQuantityAction =
  | 'map-client'
  | 'map-service'
  | 'enable-tracking'
  | 'add-to-contract'
  | 'resolve-contract'
  | 'no-change'
  | 'increase'
  | 'decrease';

export interface Pax8ReconciliationPreviewRow {
  externalClientId: string;
  externalClientName: string;
  externalProductId: string;
  externalProductName: string;
  externalSku?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  serviceId?: string | null;
  serviceName?: string | null;
  vendorQuantity: number;
  psaQuantity?: number | null;
  quantityDelta?: number | null;
  capturedAt: string;
  syncQuantity: boolean;
  status: Pax8ReconciliationStatus;
  proposedAction: Pax8ProposedQuantityAction;
  contractMatchCount: number;
  contractLineId?: string | null;
  contractLineName?: string | null;
  clientRate?: number | null;
}

interface ContractQuantityMatch {
  client_id: string;
  service_id: string;
  client_contract_id: string;
  contract_id: string;
  contract_line_id: string;
  contract_line_name: string | null;
  quantity: string | number | null;
  custom_rate: string | number | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pairKey(clientId: string, serviceId: string): string {
  return `${clientId}:${serviceId}`;
}

function snapshotKey(externalClientId: string, externalProductId: string): string {
  return `${externalClientId}:${externalProductId}`;
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export const getPax8ReconciliationPreview = withAuth(async (
  user,
  { tenant },
): Promise<{ success: boolean; error?: string; rows?: Pax8ReconciliationPreviewRow[] }> => {
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

    // Snapshots are immutable. Keep only the newest record for each Pax8
    // customer/product pair to represent current discovered quantity.
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

    const [clients, services] = await Promise.all([
      mappedClientIds.length > 0
        ? db.table('clients').whereIn('client_id', mappedClientIds).select('client_id', 'client_name')
        : Promise.resolve([]),
      mappedServiceIds.length > 0
        ? db.table('service_catalog').whereIn('service_id', mappedServiceIds).select('service_id', 'service_name')
        : Promise.resolve([]),
    ]);

    const clientNameById = new Map((clients as any[]).map((client) => [client.client_id, client.client_name]));
    const serviceNameById = new Map((services as any[]).map((service) => [service.service_id, service.service_name]));

    const contractMatchesByPair = new Map<string, ContractQuantityMatch[]>();
    if (mappedClientIds.length > 0 && mappedServiceIds.length > 0) {
      const now = new Date().toISOString();
      const contractQuery = db.table('client_contracts as cc');
      db.tenantJoin(contractQuery, 'contracts as co', 'cc.contract_id', 'co.contract_id');
      db.tenantJoin(contractQuery, 'contract_lines as cl', 'cl.contract_id', 'cc.contract_id');
      db.tenantJoin(
        contractQuery,
        'contract_line_service_configuration as cfg',
        'cfg.contract_line_id',
        'cl.contract_line_id',
        { rootTenantColumn: 'cc.tenant' },
      );

      const contractMatches = await contractQuery
        .whereIn('cc.client_id', mappedClientIds)
        .whereIn('cfg.service_id', mappedServiceIds)
        .where('cc.is_active', true)
        .where('co.status', 'active')
        .andWhere((builder) => builder.whereNull('cc.start_date').orWhere('cc.start_date', '<=', now))
        .andWhere((builder) => builder.whereNull('cc.end_date').orWhere('cc.end_date', '>=', now))
        .select(
          'cc.client_id',
          'cfg.service_id',
          'cc.client_contract_id',
          'cc.contract_id',
          'cl.contract_line_id',
          'cl.contract_line_name',
          'cfg.quantity',
          'cfg.custom_rate',
        ) as unknown as ContractQuantityMatch[];

      for (const match of contractMatches) {
        const key = pairKey(match.client_id, match.service_id);
        const entries = contractMatchesByPair.get(key) ?? [];
        entries.push(match);
        contractMatchesByPair.set(key, entries);
      }
    }

    const rows: Pax8ReconciliationPreviewRow[] = [];
    for (const snapshot of latestSnapshots.values()) {
      const clientMapping = clientMappingByExternal.get(snapshot.external_client_id);
      const serviceMapping = serviceMappingByExternal.get(snapshot.external_product_id);
      const clientMapped = clientMapping?.mapping_status === 'mapped' && Boolean(clientMapping.client_id);
      const serviceMapped = serviceMapping?.mapping_status === 'mapped' && Boolean(serviceMapping.service_id);
      const clientId = clientMapped ? clientMapping?.client_id ?? null : null;
      const serviceId = serviceMapped ? serviceMapping?.service_id ?? null : null;
      const matches = clientId && serviceId
        ? contractMatchesByPair.get(pairKey(clientId, serviceId)) ?? []
        : [];

      const vendorQuantity = finiteNumber(snapshot.quantity) ?? 0;
      let status: Pax8ReconciliationStatus;
      let proposedAction: Pax8ProposedQuantityAction;
      let psaQuantity: number | null = null;
      let quantityDelta: number | null = null;

      if (!clientMapped) {
        status = 'unmapped-client';
        proposedAction = 'map-client';
      } else if (!serviceMapped) {
        status = 'unmapped-service';
        proposedAction = 'map-service';
      } else if (!serviceMapping?.sync_quantity) {
        status = 'tracking-disabled';
        proposedAction = 'enable-tracking';
      } else if (matches.length === 0) {
        status = 'no-contract-service';
        proposedAction = 'add-to-contract';
      } else if (matches.length > 1) {
        status = 'ambiguous-contract';
        proposedAction = 'resolve-contract';
      } else {
        status = 'ready';
        psaQuantity = finiteNumber(matches[0].quantity) ?? 0;
        quantityDelta = vendorQuantity - psaQuantity;
        proposedAction = quantityDelta === 0 ? 'no-change' : quantityDelta > 0 ? 'increase' : 'decrease';
      }

      rows.push({
        externalClientId: snapshot.external_client_id,
        externalClientName: clientMapping?.external_client_name ?? snapshot.external_client_id,
        externalProductId: snapshot.external_product_id,
        externalProductName: serviceMapping?.external_product_name ?? snapshot.external_product_id,
        externalSku: serviceMapping?.external_sku ?? null,
        clientId,
        clientName: clientId ? clientNameById.get(clientId) ?? null : null,
        serviceId,
        serviceName: serviceId ? serviceNameById.get(serviceId) ?? null : null,
        vendorQuantity,
        psaQuantity,
        quantityDelta,
        capturedAt: snapshot.captured_at,
        syncQuantity: Boolean(serviceMapping?.sync_quantity),
        status,
        proposedAction,
        contractMatchCount: matches.length,
        contractLineId: matches.length === 1 ? matches[0].contract_line_id : null,
        contractLineName: matches.length === 1 ? matches[0].contract_line_name : null,
        clientRate: matches.length === 1 ? finiteNumber(matches[0].custom_rate) : null,
      });
    }

    rows.sort((left, right) => (
      left.externalClientName.localeCompare(right.externalClientName)
      || left.externalProductName.localeCompare(right.externalProductName)
    ));

    return { success: true, rows };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});
