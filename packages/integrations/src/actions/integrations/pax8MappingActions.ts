'use server';

import { withAuth } from '@alga-psa/auth';
import { hasPermission } from '@alga-psa/auth/rbac';
import { createTenantKnex, tenantDb } from '@alga-psa/db';
import type { IVendorClientMapping, IVendorServiceMapping } from '@alga-psa/types';
import {
  listVendorClientMappings,
  listVendorIntegrations,
  listVendorServiceMappings,
  setVendorClientMapping,
  setVendorServiceMapping,
} from '../../services/vendorIntegrationService';

const PROVIDER = 'pax8' as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function findPax8Integration(tenant: string) {
  const { knex } = await createTenantKnex();
  const integrations = await listVendorIntegrations(knex, tenant);
  const integration = integrations.find((item) => item.provider === PROVIDER);
  return { knex, integration };
}

export const listPax8Mappings = withAuth(async (
  user,
  { tenant },
): Promise<{
  success: boolean;
  error?: string;
  clientMappings?: IVendorClientMapping[];
  serviceMappings?: IVendorServiceMapping[];
}> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'read');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex, integration } = await findPax8Integration(tenant);
    if (!integration) {
      return { success: true, clientMappings: [], serviceMappings: [] };
    }

    const [clientMappings, serviceMappings] = await Promise.all([
      listVendorClientMappings(knex, tenant, integration.integration_id),
      listVendorServiceMappings(knex, tenant, integration.integration_id),
    ]);

    return { success: true, clientMappings, serviceMappings };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});

export const mapPax8Client = withAuth(async (
  user,
  { tenant },
  input: {
    externalClientId: string;
    clientId: string | null;
    ignore?: boolean;
  },
): Promise<{ success: boolean; error?: string; mapping?: IVendorClientMapping }> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'update');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex, integration } = await findPax8Integration(tenant);
    if (!integration) return { success: false, error: 'Pax8 is not configured' };

    if (input.clientId) {
      const client = await tenantDb(knex, tenant).table('clients')
        .where({ client_id: input.clientId })
        .first('client_id');
      if (!client) return { success: false, error: 'Selected AlgaPSA client does not exist' };
    }

    const status = input.ignore ? 'ignored' : input.clientId ? 'mapped' : 'unmapped';
    const mapping = await setVendorClientMapping(
      knex,
      tenant,
      integration.integration_id,
      input.externalClientId,
      input.ignore ? null : input.clientId,
      status,
    );

    if (!mapping) return { success: false, error: 'Pax8 customer mapping was not found' };
    return { success: true, mapping };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});

export const mapPax8Service = withAuth(async (
  user,
  { tenant },
  input: {
    externalProductId: string;
    serviceId: string | null;
    ignore?: boolean;
    syncQuantity?: boolean;
    syncCost?: boolean;
  },
): Promise<{ success: boolean; error?: string; mapping?: IVendorServiceMapping }> => {
  const permitted = await hasPermission(user as any, 'system_settings', 'update');
  if (!permitted) return { success: false, error: 'Forbidden' };

  try {
    const { knex, integration } = await findPax8Integration(tenant);
    if (!integration) return { success: false, error: 'Pax8 is not configured' };

    if (input.serviceId) {
      const service = await tenantDb(knex, tenant).table('service_catalog')
        .where({ service_id: input.serviceId })
        .first('service_id');
      if (!service) return { success: false, error: 'Selected AlgaPSA service does not exist' };
    }

    const mapping = await setVendorServiceMapping(
      knex,
      tenant,
      integration.integration_id,
      input.externalProductId,
      {
        service_id: input.ignore ? null : input.serviceId,
        mapping_status: input.ignore ? 'ignored' : input.serviceId ? 'mapped' : 'unmapped',
        sync_quantity: input.ignore ? false : input.syncQuantity,
        sync_cost: input.ignore ? false : input.syncCost,
      },
    );

    if (!mapping) return { success: false, error: 'Pax8 product mapping was not found' };
    return { success: true, mapping };
  } catch (error) {
    return { success: false, error: errorMessage(error) };
  }
});
