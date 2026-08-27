import type { TenantEntity } from '.';

export const VENDOR_PROVIDERS = ['pax8', 'acronis', 'bitdefender'] as const;
export type VendorProvider = (typeof VENDOR_PROVIDERS)[number];

export type VendorIntegrationStatus = 'disconnected' | 'connected' | 'error';
export type VendorMappingStatus = 'unmapped' | 'mapped' | 'ignored';
export type VendorSyncStatus = 'pending' | 'running' | 'success' | 'partial' | 'failed';
export type VendorSyncType = 'clients' | 'products' | 'usage' | 'full' | 'reconciliation';

export interface IVendorIntegration extends TenantEntity {
  integration_id: string;
  provider: VendorProvider;
  display_name: string;
  status: VendorIntegrationStatus;
  config: Record<string, unknown>;
  last_sync_at?: string | null;
  last_sync_status?: VendorSyncStatus | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface IVendorClientMapping extends TenantEntity {
  mapping_id: string;
  integration_id: string;
  external_client_id: string;
  external_client_name: string;
  client_id?: string | null;
  mapping_status: VendorMappingStatus;
  metadata: Record<string, unknown>;
  last_seen_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface IVendorServiceMapping extends TenantEntity {
  mapping_id: string;
  integration_id: string;
  external_product_id: string;
  external_product_name: string;
  external_sku?: string | null;
  service_id?: string | null;
  mapping_status: VendorMappingStatus;
  sync_quantity: boolean;
  sync_cost: boolean;
  metadata: Record<string, unknown>;
  last_seen_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface IVendorUsageSnapshot extends TenantEntity {
  snapshot_id: string;
  integration_id: string;
  external_client_id: string;
  external_product_id: string;
  client_id?: string | null;
  service_id?: string | null;
  quantity: number;
  unit_cost?: number | null;
  currency_code?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  captured_at: string;
  metadata: Record<string, unknown>;
}

export interface IVendorSyncRun extends TenantEntity {
  sync_run_id: string;
  integration_id: string;
  sync_type: VendorSyncType;
  status: VendorSyncStatus;
  started_at: string;
  finished_at?: string | null;
  records_seen: number;
  records_created: number;
  records_updated: number;
  records_failed: number;
  error_message?: string | null;
  metadata: Record<string, unknown>;
}

export interface IVendorReconciliationRow extends TenantEntity {
  integration_id: string;
  provider: VendorProvider;
  client_id?: string | null;
  client_name?: string | null;
  service_id?: string | null;
  service_name?: string | null;
  external_client_id: string;
  external_client_name: string;
  external_product_id: string;
  external_product_name: string;
  external_sku?: string | null;
  vendor_quantity: number;
  psa_quantity?: number | null;
  quantity_delta?: number | null;
  unit_cost?: number | null;
  currency_code?: string | null;
  captured_at: string;
  client_mapping_status: VendorMappingStatus;
  service_mapping_status: VendorMappingStatus;
}
