'use strict';

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE vendor_sync_runs
    DROP CONSTRAINT IF EXISTS vendor_sync_runs_type_check
  `);

  await knex.raw(`
    ALTER TABLE vendor_sync_runs
    ADD CONSTRAINT vendor_sync_runs_type_check
    CHECK (sync_type IN ('clients', 'products', 'usage', 'full', 'reconciliation'))
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE vendor_sync_runs
    DROP CONSTRAINT IF EXISTS vendor_sync_runs_type_check
  `);

  await knex.raw(`
    ALTER TABLE vendor_sync_runs
    ADD CONSTRAINT vendor_sync_runs_type_check
    CHECK (sync_type IN ('clients', 'products', 'usage', 'full'))
  `);
};
