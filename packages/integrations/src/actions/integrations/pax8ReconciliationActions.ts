'use server';

import type { Knex } from 'knex';
import { withAuth } from '@alga-psa/auth';
import { hasPermission } from '@alga-psa/auth/rbac';
import { createTenantKnex, tenantDb } from '@alga-psa/db';
import {
  beginVendorSyncRun,
  finishVendorSyncRun,
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
  contractConfigId?: string | null;
  clientRate?: number | null;
}

export interface Pax8ReconciliationSelection {
  externalClientId: string;
  externalProductId: string;
  expectedCapturedAt: string;
  expectedVendorQuantity: number;
  expectedPsaQuantity: number;
}

export interface Pax8ReconciliationAppliedRow {
  externalClientId: string;
  externalProductId: string;
  clientName: string;
  serviceName: string;
  previousQuantity: number;
  newQuantity: number;
}

interface ContractQuantityMatch {
  client_id: string;
  service_id: string;
  client_contract_id: string;
  contract_id: string;
  contract_line_id: string;
  contract_line_name: string | null;
  config_id: string;
  quantity: string | number | null;
  custom_rate: string | number | null;
}

interface ReconciliationBuildResult {
  integrationId: string | null;
  rows: Pax8ReconciliationPreviewRow[];
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

function selectionKey(externalClientId: string, externalProductId: string): string {
  return `${externalClientId}:${externalProductId}`;
}

function finiteNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function quantitiesEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000001;
}

async function buildPax8ReconciliationPreview(
  conn: Knex | Knex.Transaction,
  tenant: string,
): Promise<ReconciliationBuildResult> {
  const integrations = await listVendorIntegrations(conn, tenant);
  const integration = integrations.find((item) => item.provider === PROVIDER);
  if (!integration) return { integrationId: null, rows: [] };

  const db = tenantDb(conn, tenant);
  const [clientMappings, serviceMappings, snapshots] = await Promise.all([
    listVendorClientMappings(conn, tenant, integration.integration_id),
    listVendorServiceMappings(conn, tenant, integration.integration_id),
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
        'cfg.config_id',
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
      contractConfigId: matches.length === 1 ? matches[0].config_id : null,
      clientRate: matches.length === 1 ? finiteNumber(matches[0].custom_rate) : null,
    });
  }

  rows.sort((left, right) => (
    left.externalClientName.localeCompare(right.externalClientName)
    || left.externalProductName.localeCompare(right.externalProductName)
  ));

  return { integrationId: integration.integration_id, rows };
}

export const getPax8ReconciliationPreview = withAuth(async (
  user,
  { tenant },
): Promise<{ success: boolean; error?: string; rows?: Pax8ReconciliationPreviewRow[] }> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'read');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex } = await createTenantKnex();
    const result = await buildPax8ReconciliationPreview(knex, tenant);
    return { success: true, rows: result.rows };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});

export const applyPax8QuantityReconciliation = withAuth(async (
  user,
  { tenant },
  selections: Pax8ReconciliationSelection[],
): Promise<{
  success: boolean;
  error?: string;
  applied?: Pax8ReconciliationAppliedRow[];
}> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'update');
  if (!permitted) return { success: false, error: 'Forbidden' };
  if (!Array.isArray(selections) || selections.length === 0) {
    return { success: false, error: 'Select at least one quantity difference to apply' };
  }

  try {
    const { knex } = await createTenantKnex();
    const applied = await knex.transaction(async (trx) => {
      const preview = await buildPax8ReconciliationPreview(trx, tenant);
      if (!preview.integrationId) throw new Error('Pax8 is not configured');

      const currentByKey = new Map(
        preview.rows.map((row) => [selectionKey(row.externalClientId, row.externalProductId), row]),
      );
      const selectedKeys = new Set<string>();
      const validated: Pax8ReconciliationPreviewRow[] = [];

      for (const selection of selections) {
        const key = selectionKey(selection.externalClientId, selection.externalProductId);
        if (selectedKeys.has(key)) throw new Error('Duplicate reconciliation row selected');
        selectedKeys.add(key);

        const row = currentByKey.get(key);
        if (!row) throw new Error('A selected Pax8 reconciliation row no longer exists. Refresh the preview and try again.');
        if (row.status !== 'ready' || !row.contractConfigId || row.psaQuantity == null || row.quantityDelta == null) {
          throw new Error(`A selected row is no longer ready to reconcile: ${row.externalClientName} / ${row.externalProductName}`);
        }
        if (row.quantityDelta === 0) {
          throw new Error(`No quantity change is required for ${row.externalClientName} / ${row.externalProductName}`);
        }
        if (row.vendorQuantity < 0) {
          throw new Error(`Pax8 returned an invalid negative quantity for ${row.externalClientName} / ${row.externalProductName}`);
        }
        if (
          row.capturedAt !== selection.expectedCapturedAt
          || !quantitiesEqual(row.vendorQuantity, selection.expectedVendorQuantity)
          || !quantitiesEqual(row.psaQuantity, selection.expectedPsaQuantity)
        ) {
          throw new Error('Reconciliation data changed since this preview was loaded. Refresh the preview before applying changes.');
        }

        validated.push(row);
      }

      const db = tenantDb(trx, tenant);
      for (const row of validated) {
        const lockedConfig = await db.table('contract_line_service_configuration')
          .where({ config_id: row.contractConfigId })
          .first('config_id', 'quantity')
          .forUpdate();
        const lockedQuantity = finiteNumber(lockedConfig?.quantity);
        if (!lockedConfig || lockedQuantity == null || row.psaQuantity == null || !quantitiesEqual(lockedQuantity, row.psaQuantity)) {
          throw new Error('An AlgaPSA contract quantity changed while reconciliation was being applied. No changes were saved.');
        }
      }

      const syncRun = await beginVendorSyncRun(
        trx,
        tenant,
        preview.integrationId,
        'reconciliation',
        {
          mode: 'manual-selected-quantity-apply',
          actor_user_id: (user as any).user_id ?? null,
          selected_count: validated.length,
          billing_invoice_writes: false,
          cost_writes: false,
          rows: validated.map((row) => ({
            external_client_id: row.externalClientId,
            external_product_id: row.externalProductId,
            client_id: row.clientId,
            service_id: row.serviceId,
            contract_line_id: row.contractLineId,
            config_id: row.contractConfigId,
            previous_quantity: row.psaQuantity,
            new_quantity: row.vendorQuantity,
            snapshot_captured_at: row.capturedAt,
          })),
        },
      );

      const now = new Date().toISOString();
      const result: Pax8ReconciliationAppliedRow[] = [];
      for (const row of validated) {
        const updated = await db.table('contract_line_service_configuration')
          .where({ config_id: row.contractConfigId })
          .update({
            quantity: row.vendorQuantity,
            updated_at: now,
          });
        if (updated !== 1) {
          throw new Error(`Failed to update contract quantity for ${row.externalClientName} / ${row.externalProductName}`);
        }

        result.push({
          externalClientId: row.externalClientId,
          externalProductId: row.externalProductId,
          clientName: row.clientName ?? row.externalClientName,
          serviceName: row.serviceName ?? row.externalProductName,
          previousQuantity: row.psaQuantity as number,
          newQuantity: row.vendorQuantity,
        });
      }

      await finishVendorSyncRun(
        trx,
        tenant,
        syncRun.sync_run_id,
        'success',
        {
          records_seen: validated.length,
          records_updated: validated.length,
          records_created: 0,
          records_failed: 0,
        },
      );

      return result;
    });

    return { success: true, applied };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});
