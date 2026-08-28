'use strict';

const VENDOR_TABLES = [
  'vendor_integrations',
  'vendor_client_mappings',
  'vendor_service_mappings',
  'vendor_usage_snapshots',
  'vendor_sync_runs',
];

async function hasCitus(knex) {
  const result = await knex.raw(`
    SELECT EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'create_distributed_table'
    ) AS available
  `);
  return Boolean(result.rows?.[0]?.available);
}

async function distributeVendorTables(knex) {
  if (!(await hasCitus(knex))) return;

  for (const table of VENDOR_TABLES) {
    await knex.raw(
      `SELECT create_distributed_table(?::regclass, 'tenant', colocate_with => 'tenants')`,
      [table],
    );
  }
}

/**
 * Shared vendor integration foundation for Pax8, Acronis, and Bitdefender.
 *
 * Design rules:
 * - AlgaPSA remains the source of truth for clients and the service catalog.
 * - External vendor customers/products are mapped to existing Alga entities.
 * - Vendor quantities/costs are recorded as immutable snapshots before any
 *   billing reconciliation is allowed to update contract quantities.
 * - Credentials are intentionally NOT stored here. Provider-specific auth must
 *   use the existing secure-secret/credential mechanisms.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('vendor_integrations', (table) => {
    table.uuid('tenant').notNullable();
    table.uuid('integration_id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('provider').notNullable();
    table.text('display_name').notNullable();
    table.text('status').notNullable().defaultTo('disconnected');
    table.jsonb('config').notNullable().defaultTo('{}');
    table.timestamp('last_sync_at', { useTz: true }).nullable();
    table.text('last_sync_status').nullable();
    table.text('last_error').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['tenant', 'integration_id']);
  });

  await knex.raw(`
    ALTER TABLE vendor_integrations
    ADD CONSTRAINT vendor_integrations_provider_check
    CHECK (provider IN ('pax8', 'acronis', 'bitdefender'))
  `);
  await knex.raw(`
    ALTER TABLE vendor_integrations
    ADD CONSTRAINT vendor_integrations_status_check
    CHECK (status IN ('disconnected', 'connected', 'error'))
  `);
  await knex.raw(`
    ALTER TABLE vendor_integrations
    ADD CONSTRAINT vendor_integrations_last_sync_status_check
    CHECK (last_sync_status IS NULL OR last_sync_status IN ('pending', 'running', 'success', 'partial', 'failed'))
  `);
  await knex.raw(`
    CREATE INDEX idx_vendor_integrations_tenant_provider
    ON vendor_integrations (tenant, provider)
  `);

  await knex.schema.createTable('vendor_client_mappings', (table) => {
    table.uuid('tenant').notNullable();
    table.uuid('mapping_id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('integration_id').notNullable();
    table.text('external_client_id').notNullable();
    table.text('external_client_name').notNullable();
    table.uuid('client_id').nullable();
    table.text('mapping_status').notNullable().defaultTo('unmapped');
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('last_seen_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['tenant', 'mapping_id']);
  });

  await knex.raw(`
    ALTER TABLE vendor_client_mappings
    ADD CONSTRAINT vendor_client_mappings_status_check
    CHECK (mapping_status IN ('unmapped', 'mapped', 'ignored'))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX idx_vendor_client_mappings_external
    ON vendor_client_mappings (tenant, integration_id, external_client_id)
  `);
  await knex.raw(`
    CREATE INDEX idx_vendor_client_mappings_client
    ON vendor_client_mappings (tenant, client_id)
  `);

  await knex.schema.createTable('vendor_service_mappings', (table) => {
    table.uuid('tenant').notNullable();
    table.uuid('mapping_id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('integration_id').notNullable();
    table.text('external_product_id').notNullable();
    table.text('external_product_name').notNullable();
    table.text('external_sku').nullable();
    table.uuid('service_id').nullable();
    table.text('mapping_status').notNullable().defaultTo('unmapped');
    table.boolean('sync_quantity').notNullable().defaultTo(false);
    table.boolean('sync_cost').notNullable().defaultTo(false);
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('last_seen_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['tenant', 'mapping_id']);
  });

  await knex.raw(`
    ALTER TABLE vendor_service_mappings
    ADD CONSTRAINT vendor_service_mappings_status_check
    CHECK (mapping_status IN ('unmapped', 'mapped', 'ignored'))
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX idx_vendor_service_mappings_external
    ON vendor_service_mappings (tenant, integration_id, external_product_id)
  `);
  await knex.raw(`
    CREATE INDEX idx_vendor_service_mappings_service
    ON vendor_service_mappings (tenant, service_id)
  `);

  await knex.schema.createTable('vendor_usage_snapshots', (table) => {
    table.uuid('tenant').notNullable();
    table.uuid('snapshot_id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('integration_id').notNullable();
    table.text('external_client_id').notNullable();
    table.text('external_product_id').notNullable();
    table.uuid('client_id').nullable();
    table.uuid('service_id').nullable();
    table.decimal('quantity', 20, 6).notNullable().defaultTo(0);
    table.decimal('unit_cost', 20, 6).nullable();
    table.string('currency_code', 3).nullable();
    table.timestamp('period_start', { useTz: true }).nullable();
    table.timestamp('period_end', { useTz: true }).nullable();
    table.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.jsonb('metadata').notNullable().defaultTo('{}');

    table.primary(['tenant', 'snapshot_id']);
  });

  await knex.raw(`
    CREATE INDEX idx_vendor_usage_snapshots_lookup
    ON vendor_usage_snapshots (
      tenant,
      integration_id,
      external_client_id,
      external_product_id,
      captured_at DESC
    )
  `);
  await knex.raw(`
    CREATE INDEX idx_vendor_usage_snapshots_mapped
    ON vendor_usage_snapshots (tenant, client_id, service_id, captured_at DESC)
  `);

  await knex.schema.createTable('vendor_sync_runs', (table) => {
    table.uuid('tenant').notNullable();
    table.uuid('sync_run_id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('integration_id').notNullable();
    table.text('sync_type').notNullable();
    table.text('status').notNullable().defaultTo('pending');
    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('finished_at', { useTz: true }).nullable();
    table.integer('records_seen').notNullable().defaultTo(0);
    table.integer('records_created').notNullable().defaultTo(0);
    table.integer('records_updated').notNullable().defaultTo(0);
    table.integer('records_failed').notNullable().defaultTo(0);
    table.text('error_message').nullable();
    table.jsonb('metadata').notNullable().defaultTo('{}');

    table.primary(['tenant', 'sync_run_id']);
  });

  await knex.raw(`
    ALTER TABLE vendor_sync_runs
    ADD CONSTRAINT vendor_sync_runs_type_check
    CHECK (sync_type IN ('clients', 'products', 'usage', 'full'))
  `);
  await knex.raw(`
    ALTER TABLE vendor_sync_runs
    ADD CONSTRAINT vendor_sync_runs_status_check
    CHECK (status IN ('pending', 'running', 'success', 'partial', 'failed'))
  `);
  await knex.raw(`
    CREATE INDEX idx_vendor_sync_runs_integration_started
    ON vendor_sync_runs (tenant, integration_id, started_at DESC)
  `);

  // Citus requires distributed/colocated tenant tables before cross-table FKs.
  await distributeVendorTables(knex);

  for (const tableName of VENDOR_TABLES) {
    await knex.schema.alterTable(tableName, (table) => {
      table.foreign('tenant').references('tenants.tenant');
    });
  }

  await knex.schema.alterTable('vendor_client_mappings', (table) => {
    table
      .foreign(['tenant', 'integration_id'])
      .references(['tenant', 'integration_id'])
      .inTable('vendor_integrations')
      .onDelete('CASCADE');
  });

  await knex.schema.alterTable('vendor_service_mappings', (table) => {
    table
      .foreign(['tenant', 'integration_id'])
      .references(['tenant', 'integration_id'])
      .inTable('vendor_integrations')
      .onDelete('CASCADE');
  });

  await knex.schema.alterTable('vendor_usage_snapshots', (table) => {
    table
      .foreign(['tenant', 'integration_id'])
      .references(['tenant', 'integration_id'])
      .inTable('vendor_integrations')
      .onDelete('CASCADE');
  });

  await knex.schema.alterTable('vendor_sync_runs', (table) => {
    table
      .foreign(['tenant', 'integration_id'])
      .references(['tenant', 'integration_id'])
      .inTable('vendor_integrations')
      .onDelete('CASCADE');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('vendor_sync_runs');
  await knex.schema.dropTableIfExists('vendor_usage_snapshots');
  await knex.schema.dropTableIfExists('vendor_service_mappings');
  await knex.schema.dropTableIfExists('vendor_client_mappings');
  await knex.schema.dropTableIfExists('vendor_integrations');
};
