'use strict';

const VENDOR_TABLES = [
  'vendor_integrations',
  'vendor_client_mappings',
  'vendor_service_mappings',
  'vendor_usage_snapshots',
  'vendor_sync_runs',
];

/**
 * Keep the Community vendor-integration foundation independent of the
 * Enterprise tenant-deletion workflow. These tables do not own business
 * entities; they only contain external mappings, sync history, and immutable
 * vendor usage snapshots. Cascading the tenant FK guarantees they are removed
 * atomically when the tenant row is removed, while the integration FK already
 * cascades child rows when an integration is deleted.
 */
exports.up = async function up(knex) {
  for (const tableName of VENDOR_TABLES) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropForeign('tenant');
    });
  }

  for (const tableName of VENDOR_TABLES) {
    await knex.schema.alterTable(tableName, (table) => {
      table
        .foreign('tenant')
        .references('tenants.tenant')
        .onDelete('CASCADE');
    });
  }
};

exports.down = async function down(knex) {
  for (const tableName of VENDOR_TABLES) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropForeign('tenant');
    });
  }

  for (const tableName of VENDOR_TABLES) {
    await knex.schema.alterTable(tableName, (table) => {
      table.foreign('tenant').references('tenants.tenant');
    });
  }
};
