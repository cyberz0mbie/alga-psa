'use server';

import { withAuth } from '@alga-psa/auth';
import { hasPermission } from '@alga-psa/auth/rbac';
import { getSecretProviderInstance } from '@alga-psa/core/secrets';
import { createTenantKnex } from '@alga-psa/db';
import {
  createVendorIntegration,
  listVendorIntegrations,
  listVendorSyncRuns,
  updateVendorIntegrationState,
} from '../../services/vendorIntegrationService';
import { Pax8ApiClient } from '../../lib/vendors/pax8/pax8ApiClient';
import { runPax8ReadOnlySync, type Pax8SyncResult } from '../../lib/vendors/pax8/pax8Sync';

const PROVIDER = 'pax8' as const;

function clientIdSecretName(integrationId: string): string {
  return `vendor_pax8_${integrationId}_client_id`;
}

function clientSecretSecretName(integrationId: string): string {
  return `vendor_pax8_${integrationId}_client_secret`;
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.min(value.length - 4, 12))}${value.slice(-4)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parsePersistedSyncResult(value: unknown): Pax8SyncResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<Record<keyof Pax8SyncResult, unknown>>;
  const keys: Array<keyof Pax8SyncResult> = [
    'companiesSeen',
    'productsSeen',
    'subscriptionsSeen',
    'usageSnapshotsCreated',
    'skippedSubscriptions',
  ];

  if (!keys.every((key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key]))) {
    return undefined;
  }

  return {
    companiesSeen: candidate.companiesSeen as number,
    productsSeen: candidate.productsSeen as number,
    subscriptionsSeen: candidate.subscriptionsSeen as number,
    usageSnapshotsCreated: candidate.usageSnapshotsCreated as number,
    skippedSubscriptions: candidate.skippedSubscriptions as number,
  };
}

async function findPax8Integration(tenant: string) {
  const { knex } = await createTenantKnex();
  const integrations = await listVendorIntegrations(knex, tenant);
  const integration = integrations.find((item) => item.provider === PROVIDER);
  return { knex, integration };
}

async function getOrCreatePax8Integration(tenant: string) {
  const found = await findPax8Integration(tenant);
  if (found.integration) return { knex: found.knex, integration: found.integration };

  const integration = await createVendorIntegration(found.knex, tenant, {
    provider: PROVIDER,
    display_name: 'Pax8',
    config: {
      mode: 'read-only',
      automatic_reconciliation: false,
    },
  });
  return { knex: found.knex, integration };
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

export const getPax8Settings = withAuth(async (
  user,
  { tenant },
): Promise<{
  success: boolean;
  error?: string;
  integration?: {
    integrationId: string;
    status: string;
    lastSyncAt?: string | null;
    lastSyncStatus?: string | null;
    lastError?: string | null;
    lastSyncResult?: Pax8SyncResult;
    mode: 'read-only';
    automaticReconciliation: false;
  };
  credentials?: {
    hasClientId: boolean;
    clientIdMasked?: string;
    hasClientSecret: boolean;
    clientSecretMasked?: string;
  };
}> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'read');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex, integration } = await findPax8Integration(tenant);
    if (!integration) {
      return {
        success: true,
        credentials: {
          hasClientId: false,
          hasClientSecret: false,
        },
      };
    }

    const secretProvider = await getSecretProviderInstance();
    const [clientId, clientSecret, latestRuns] = await Promise.all([
      secretProvider.getTenantSecret(tenant, clientIdSecretName(integration.integration_id)),
      secretProvider.getTenantSecret(tenant, clientSecretSecretName(integration.integration_id)),
      listVendorSyncRuns(knex, tenant, integration.integration_id, 1),
    ]);
    const lastSyncResult = parsePersistedSyncResult(latestRuns[0]?.metadata?.pax8Result);

    return {
      success: true,
      integration: {
        integrationId: integration.integration_id,
        status: integration.status,
        lastSyncAt: integration.last_sync_at ?? null,
        lastSyncStatus: integration.last_sync_status ?? null,
        lastError: integration.last_error ?? null,
        lastSyncResult,
        mode: 'read-only',
        automaticReconciliation: false,
      },
      credentials: {
        hasClientId: Boolean(clientId),
        clientIdMasked: clientId ? maskSecret(clientId) : undefined,
        hasClientSecret: Boolean(clientSecret),
        clientSecretMasked: clientSecret ? maskSecret(clientSecret) : undefined,
      },
    };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});

export const savePax8Configuration = withAuth(async (
  user,
  { tenant },
  input: {
    clientId?: string;
    clientSecret?: string;
  },
): Promise<{ success: boolean; error?: string }> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'update');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex, integration } = await getOrCreatePax8Integration(tenant);
    const secretProvider = await getSecretProviderInstance();

    const suppliedClientId = input.clientId?.trim();
    const suppliedClientSecret = input.clientSecret?.trim();

    const existingClientId = await secretProvider.getTenantSecret(
      tenant,
      clientIdSecretName(integration.integration_id),
    );
    const existingClientSecret = await secretProvider.getTenantSecret(
      tenant,
      clientSecretSecretName(integration.integration_id),
    );

    const clientId = suppliedClientId || existingClientId;
    const clientSecret = suppliedClientSecret || existingClientSecret;

    if (!clientId || !clientSecret) {
      return { success: false, error: 'Pax8 client ID and client secret are required' };
    }

    if (suppliedClientId) {
      await secretProvider.setTenantSecret(
        tenant,
        clientIdSecretName(integration.integration_id),
        suppliedClientId,
      );
    }
    if (suppliedClientSecret) {
      await secretProvider.setTenantSecret(
        tenant,
        clientSecretSecretName(integration.integration_id),
        suppliedClientSecret,
      );
    }

    // Saving credentials does not imply they work. A successful connection
    // test moves the integration into connected state.
    await updateVendorIntegrationState(knex, tenant, integration.integration_id, {
      status: 'disconnected',
      last_error: null,
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});

export const testPax8Connection = withAuth(async (
  user,
  { tenant },
): Promise<{ success: boolean; error?: string }> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'update');
  if (!permitted) return { success: false, error: 'Forbidden' };

  const found = await findPax8Integration(tenant);
  if (!found.integration) {
    return { success: false, error: 'Pax8 is not configured' };
  }

  try {
    const client = await buildConfiguredPax8Client(tenant, found.integration.integration_id);
    await client.testConnection();

    await updateVendorIntegrationState(found.knex, tenant, found.integration.integration_id, {
      status: 'connected',
      last_error: null,
    });

    return { success: true };
  } catch (error) {
    const message = errorMessage(error);
    await updateVendorIntegrationState(found.knex, tenant, found.integration.integration_id, {
      status: 'error',
      last_error: message,
    }).catch(() => undefined);
    return { success: false, error: message };
  }
});

export const disconnectPax8Integration = withAuth(async (
  user,
  { tenant },
): Promise<{ success: boolean; error?: string }> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'update');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex, integration } = await findPax8Integration(tenant);
    if (!integration) return { success: true };

    const secretProvider = await getSecretProviderInstance();
    await Promise.all([
      secretProvider.deleteTenantSecret(tenant, clientIdSecretName(integration.integration_id)).catch(() => undefined),
      secretProvider.deleteTenantSecret(tenant, clientSecretSecretName(integration.integration_id)).catch(() => undefined),
    ]);

    await updateVendorIntegrationState(knex, tenant, integration.integration_id, {
      status: 'disconnected',
      last_error: null,
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});

export const syncPax8ReadOnly = withAuth(async (
  user,
  { tenant },
): Promise<{ success: boolean; error?: string; result?: Pax8SyncResult }> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'update');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex, integration } = await findPax8Integration(tenant);
    if (!integration) return { success: false, error: 'Pax8 is not configured' };

    const client = await buildConfiguredPax8Client(tenant, integration.integration_id);
    const result = await runPax8ReadOnlySync(knex, tenant, integration.integration_id, client);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});
