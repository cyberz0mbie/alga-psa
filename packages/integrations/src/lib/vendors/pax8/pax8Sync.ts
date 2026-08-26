import type { Knex } from 'knex';
import {
  beginVendorSyncRun,
  finishVendorSyncRun,
  listVendorClientMappings,
  listVendorServiceMappings,
  recordVendorUsageSnapshot,
  updateVendorIntegrationState,
  upsertDiscoveredVendorClient,
  upsertDiscoveredVendorService,
} from '../../../services/vendorIntegrationService';
import type { Pax8ApiClient, Pax8Product, Pax8Subscription } from './pax8ApiClient';

export interface Pax8SyncResult {
  companiesSeen: number;
  productsSeen: number;
  subscriptionsSeen: number;
  usageSnapshotsCreated: number;
  skippedSubscriptions: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isSubscriptionCurrent(subscription: Pax8Subscription, now: Date): boolean {
  if (subscription.startDate) {
    const start = new Date(subscription.startDate);
    if (!Number.isNaN(start.getTime()) && start > now) return false;
  }

  if (subscription.endDate) {
    const end = new Date(subscription.endDate);
    if (!Number.isNaN(end.getTime()) && end < now) return false;
  }

  return true;
}

async function fetchProductsInBatches(
  client: Pax8ApiClient,
  productIds: string[],
  concurrency = 10,
): Promise<Map<string, Pax8Product>> {
  const result = new Map<string, Pax8Product>();

  for (let i = 0; i < productIds.length; i += concurrency) {
    const batch = productIds.slice(i, i + concurrency);
    const products = await Promise.all(batch.map((productId) => client.getProduct(productId)));
    for (const product of products) {
      result.set(product.id, product);
    }
  }

  return result;
}

/**
 * Read-only Pax8 synchronization.
 *
 * This function deliberately does NOT update AlgaPSA contracts or invoices.
 * It discovers external entities, updates mapping candidates, and records
 * current subscription quantities as immutable usage snapshots. A later
 * reconciliation/apply workflow can compare these snapshots against AlgaPSA
 * contract quantities after an admin has explicitly mapped the client/service.
 */
export async function runPax8ReadOnlySync(
  conn: Knex | Knex.Transaction,
  tenant: string,
  integrationId: string,
  client: Pax8ApiClient,
): Promise<Pax8SyncResult> {
  const syncRun = await beginVendorSyncRun(conn, tenant, integrationId, 'full', {
    mode: 'read-only',
    provider: 'pax8',
  });

  try {
    await updateVendorIntegrationState(conn, tenant, integrationId, {
      status: 'connected',
      last_sync_status: 'running',
      last_error: null,
    });

    const [companies, subscriptions] = await Promise.all([
      client.listCompanies(),
      client.listSubscriptions(),
    ]);

    for (const company of companies) {
      await upsertDiscoveredVendorClient(conn, tenant, integrationId, {
        external_client_id: company.id,
        external_client_name: company.name,
        metadata: {
          status: company.status ?? null,
          externalId: company.externalId ?? null,
          website: company.website ?? null,
          phone: company.phone ?? null,
        },
      });
    }

    // Pax8 can expose a very large product catalog. Only discover products that
    // are actually referenced by this partner's subscriptions.
    const uniqueProductIds = Array.from(
      new Set(subscriptions.map((subscription) => subscription.productId).filter(Boolean)),
    );
    const productsById = await fetchProductsInBatches(client, uniqueProductIds);

    for (const product of productsById.values()) {
      await upsertDiscoveredVendorService(conn, tenant, integrationId, {
        external_product_id: product.id,
        external_product_name: product.name,
        external_sku: product.sku ?? null,
        metadata: {
          vendor: product.vendorName ?? product.vendor ?? null,
        },
      });
    }

    const [clientMappings, serviceMappings] = await Promise.all([
      listVendorClientMappings(conn, tenant, integrationId),
      listVendorServiceMappings(conn, tenant, integrationId),
    ]);

    const clientMap = new Map(clientMappings.map((mapping) => [mapping.external_client_id, mapping]));
    const serviceMap = new Map(serviceMappings.map((mapping) => [mapping.external_product_id, mapping]));

    // Aggregate subscriptions by company/product so an account with more than
    // one current Pax8 subscription for the same product produces one quantity
    // snapshot for reconciliation.
    const currentSubscriptions = subscriptions.filter((subscription) =>
      isSubscriptionCurrent(subscription, new Date()),
    );

    const aggregate = new Map<
      string,
      {
        companyId: string;
        productId: string;
        quantity: number;
        subscriptionIds: string[];
        billingTerms: string[];
        statuses: string[];
      }
    >();

    let skippedSubscriptions = 0;
    for (const subscription of currentSubscriptions) {
      if (!subscription.companyId || !subscription.productId) {
        skippedSubscriptions += 1;
        continue;
      }

      const quantity = Number(subscription.quantity ?? 0);
      if (!Number.isFinite(quantity)) {
        skippedSubscriptions += 1;
        continue;
      }

      const key = `${subscription.companyId}:${subscription.productId}`;
      const existing = aggregate.get(key) ?? {
        companyId: subscription.companyId,
        productId: subscription.productId,
        quantity: 0,
        subscriptionIds: [],
        billingTerms: [],
        statuses: [],
      };

      existing.quantity += quantity;
      existing.subscriptionIds.push(subscription.id);
      if (subscription.billingTerm) existing.billingTerms.push(subscription.billingTerm);
      if (subscription.status) existing.statuses.push(subscription.status);
      aggregate.set(key, existing);
    }

    let usageSnapshotsCreated = 0;
    const capturedAt = new Date().toISOString();

    for (const entry of aggregate.values()) {
      const clientMapping = clientMap.get(entry.companyId);
      const serviceMapping = serviceMap.get(entry.productId);

      await recordVendorUsageSnapshot(conn, tenant, integrationId, {
        external_client_id: entry.companyId,
        external_product_id: entry.productId,
        client_id: clientMapping?.mapping_status === 'mapped' ? clientMapping.client_id ?? null : null,
        service_id: serviceMapping?.mapping_status === 'mapped' ? serviceMapping.service_id ?? null : null,
        quantity: entry.quantity,
        captured_at: capturedAt,
        metadata: {
          subscriptionIds: entry.subscriptionIds,
          billingTerms: Array.from(new Set(entry.billingTerms)),
          statuses: Array.from(new Set(entry.statuses)),
        },
      });
      usageSnapshotsCreated += 1;
    }

    const result: Pax8SyncResult = {
      companiesSeen: companies.length,
      productsSeen: productsById.size,
      subscriptionsSeen: subscriptions.length,
      usageSnapshotsCreated,
      skippedSubscriptions,
    };

    await finishVendorSyncRun(
      conn,
      tenant,
      syncRun.sync_run_id,
      skippedSubscriptions > 0 ? 'partial' : 'success',
      {
        records_seen: companies.length + productsById.size + subscriptions.length,
        records_created: usageSnapshotsCreated,
        records_failed: skippedSubscriptions,
      },
      skippedSubscriptions > 0 ? `${skippedSubscriptions} subscriptions could not be normalized` : null,
    );

    await updateVendorIntegrationState(conn, tenant, integrationId, {
      status: 'connected',
      last_sync_at: capturedAt,
      last_sync_status: skippedSubscriptions > 0 ? 'partial' : 'success',
      last_error: skippedSubscriptions > 0 ? `${skippedSubscriptions} subscriptions could not be normalized` : null,
    });

    return result;
  } catch (error) {
    const message = errorMessage(error);

    await finishVendorSyncRun(conn, tenant, syncRun.sync_run_id, 'failed', {}, message);
    await updateVendorIntegrationState(conn, tenant, integrationId, {
      status: 'error',
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'failed',
      last_error: message,
    });

    throw error;
  }
}
