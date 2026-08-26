import type { Knex } from 'knex';
import { tenantDb } from '@alga-psa/db';
import type {
  IVendorClientMapping,
  IVendorIntegration,
  IVendorServiceMapping,
  IVendorSyncRun,
  IVendorUsageSnapshot,
  VendorIntegrationStatus,
  VendorMappingStatus,
  VendorProvider,
  VendorSyncStatus,
  VendorSyncType,
} from '@alga-psa/types';

export interface CreateVendorIntegrationInput {
  provider: VendorProvider;
  display_name: string;
  config?: Record<string, unknown>;
}

export interface DiscoveredVendorClientInput {
  external_client_id: string;
  external_client_name: string;
  metadata?: Record<string, unknown>;
}

export interface DiscoveredVendorServiceInput {
  external_product_id: string;
  external_product_name: string;
  external_sku?: string | null;
  metadata?: Record<string, unknown>;
}

export interface VendorUsageSnapshotInput {
  external_client_id: string;
  external_product_id: string;
  client_id?: string | null;
  service_id?: string | null;
  quantity: number;
  unit_cost?: number | null;
  currency_code?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  captured_at?: string;
  metadata?: Record<string, unknown>;
}

export interface VendorSyncRunCounts {
  records_seen?: number;
  records_created?: number;
  records_updated?: number;
  records_failed?: number;
}

function table(conn: Knex | Knex.Transaction, tenant: string, name: string) {
  return tenantDb(conn, tenant).table(name);
}

function normalizeUsageSnapshot(row: Record<string, unknown>): IVendorUsageSnapshot {
  return {
    ...(row as unknown as IVendorUsageSnapshot),
    quantity: Number(row.quantity ?? 0),
    unit_cost: row.unit_cost == null ? null : Number(row.unit_cost),
  };
}

export async function listVendorIntegrations(
  conn: Knex | Knex.Transaction,
  tenant: string,
): Promise<IVendorIntegration[]> {
  return table(conn, tenant, 'vendor_integrations')
    .select('*')
    .orderBy('provider', 'asc')
    .orderBy('display_name', 'asc') as Promise<IVendorIntegration[]>;
}

export async function getVendorIntegration(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
): Promise<IVendorIntegration | undefined> {
  return table(conn, tenant, 'vendor_integrations')
    .where({ integration_id: integrationId })
    .first() as Promise<IVendorIntegration | undefined>;
}

export async function createVendorIntegration(
  conn: Knex | Knex.Transaction,
  tenant: string,
  input: CreateVendorIntegrationInput,
): Promise<IVendorIntegration> {
  const [created] = await table(conn, tenant, 'vendor_integrations')
    .insert({
      tenant,
      provider: input.provider,
      display_name: input.display_name,
      status: 'disconnected',
      config: input.config ?? {},
    })
    .returning('*');

  return created as IVendorIntegration;
}

export async function updateVendorIntegrationState(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  input: {
    status?: VendorIntegrationStatus;
    config?: Record<string, unknown>;
    last_sync_at?: string | null;
    last_sync_status?: VendorSyncStatus | null;
    last_error?: string | null;
  },
): Promise<IVendorIntegration | undefined> {
  const [updated] = await table(conn, tenant, 'vendor_integrations')
    .where({ integration_id: integrationId })
    .update({
      ...input,
      updated_at: new Date().toISOString(),
    })
    .returning('*');

  return updated as IVendorIntegration | undefined;
}

export async function upsertDiscoveredVendorClient(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  input: DiscoveredVendorClientInput,
): Promise<IVendorClientMapping> {
  const now = new Date().toISOString();
  const [row] = await table(conn, tenant, 'vendor_client_mappings')
    .insert({
      tenant,
      integration_id: integrationId,
      external_client_id: input.external_client_id,
      external_client_name: input.external_client_name,
      mapping_status: 'unmapped',
      metadata: input.metadata ?? {},
      last_seen_at: now,
      updated_at: now,
    })
    .onConflict(['tenant', 'integration_id', 'external_client_id'])
    .merge({
      external_client_name: input.external_client_name,
      metadata: input.metadata ?? {},
      last_seen_at: now,
      updated_at: now,
    })
    .returning('*');

  return row as IVendorClientMapping;
}

export async function setVendorClientMapping(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  externalClientId: string,
  clientId: string | null,
  status: VendorMappingStatus = clientId ? 'mapped' : 'unmapped',
): Promise<IVendorClientMapping | undefined> {
  const [updated] = await table(conn, tenant, 'vendor_client_mappings')
    .where({
      integration_id: integrationId,
      external_client_id: externalClientId,
    })
    .update({
      client_id: clientId,
      mapping_status: status,
      updated_at: new Date().toISOString(),
    })
    .returning('*');

  return updated as IVendorClientMapping | undefined;
}

export async function listVendorClientMappings(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
): Promise<IVendorClientMapping[]> {
  return table(conn, tenant, 'vendor_client_mappings')
    .where({ integration_id: integrationId })
    .select('*')
    .orderBy('external_client_name', 'asc') as Promise<IVendorClientMapping[]>;
}

export async function upsertDiscoveredVendorService(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  input: DiscoveredVendorServiceInput,
): Promise<IVendorServiceMapping> {
  const now = new Date().toISOString();
  const [row] = await table(conn, tenant, 'vendor_service_mappings')
    .insert({
      tenant,
      integration_id: integrationId,
      external_product_id: input.external_product_id,
      external_product_name: input.external_product_name,
      external_sku: input.external_sku ?? null,
      mapping_status: 'unmapped',
      metadata: input.metadata ?? {},
      last_seen_at: now,
      updated_at: now,
    })
    .onConflict(['tenant', 'integration_id', 'external_product_id'])
    .merge({
      external_product_name: input.external_product_name,
      external_sku: input.external_sku ?? null,
      metadata: input.metadata ?? {},
      last_seen_at: now,
      updated_at: now,
    })
    .returning('*');

  return row as IVendorServiceMapping;
}

export async function setVendorServiceMapping(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  externalProductId: string,
  input: {
    service_id: string | null;
    mapping_status?: VendorMappingStatus;
    sync_quantity?: boolean;
    sync_cost?: boolean;
  },
): Promise<IVendorServiceMapping | undefined> {
  const [updated] = await table(conn, tenant, 'vendor_service_mappings')
    .where({
      integration_id: integrationId,
      external_product_id: externalProductId,
    })
    .update({
      service_id: input.service_id,
      mapping_status: input.mapping_status ?? (input.service_id ? 'mapped' : 'unmapped'),
      ...(input.sync_quantity === undefined ? {} : { sync_quantity: input.sync_quantity }),
      ...(input.sync_cost === undefined ? {} : { sync_cost: input.sync_cost }),
      updated_at: new Date().toISOString(),
    })
    .returning('*');

  return updated as IVendorServiceMapping | undefined;
}

export async function listVendorServiceMappings(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
): Promise<IVendorServiceMapping[]> {
  return table(conn, tenant, 'vendor_service_mappings')
    .where({ integration_id: integrationId })
    .select('*')
    .orderBy('external_product_name', 'asc') as Promise<IVendorServiceMapping[]>;
}

export async function recordVendorUsageSnapshot(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  input: VendorUsageSnapshotInput,
): Promise<IVendorUsageSnapshot> {
  const [created] = await table(conn, tenant, 'vendor_usage_snapshots')
    .insert({
      tenant,
      integration_id: integrationId,
      external_client_id: input.external_client_id,
      external_product_id: input.external_product_id,
      client_id: input.client_id ?? null,
      service_id: input.service_id ?? null,
      quantity: input.quantity,
      unit_cost: input.unit_cost ?? null,
      currency_code: input.currency_code ?? null,
      period_start: input.period_start ?? null,
      period_end: input.period_end ?? null,
      captured_at: input.captured_at ?? new Date().toISOString(),
      metadata: input.metadata ?? {},
    })
    .returning('*');

  return normalizeUsageSnapshot(created);
}

export async function beginVendorSyncRun(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  syncType: VendorSyncType,
  metadata: Record<string, unknown> = {},
): Promise<IVendorSyncRun> {
  const [created] = await table(conn, tenant, 'vendor_sync_runs')
    .insert({
      tenant,
      integration_id: integrationId,
      sync_type: syncType,
      status: 'running',
      metadata,
    })
    .returning('*');

  return created as IVendorSyncRun;
}

export async function finishVendorSyncRun(
  conn: Knex | Knex.Transaction,
  tenant: string,
  syncRunId: string,
  status: Exclude<VendorSyncStatus, 'pending' | 'running'>,
  counts: VendorSyncRunCounts = {},
  errorMessage: string | null = null,
): Promise<IVendorSyncRun | undefined> {
  const [updated] = await table(conn, tenant, 'vendor_sync_runs')
    .where({ sync_run_id: syncRunId })
    .update({
      status,
      finished_at: new Date().toISOString(),
      records_seen: counts.records_seen ?? 0,
      records_created: counts.records_created ?? 0,
      records_updated: counts.records_updated ?? 0,
      records_failed: counts.records_failed ?? 0,
      error_message: errorMessage,
    })
    .returning('*');

  return updated as IVendorSyncRun | undefined;
}

export async function listVendorSyncRuns(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  limit = 25,
): Promise<IVendorSyncRun[]> {
  return table(conn, tenant, 'vendor_sync_runs')
    .where({ integration_id: integrationId })
    .select('*')
    .orderBy('started_at', 'desc')
    .limit(limit) as Promise<IVendorSyncRun[]>;
}
