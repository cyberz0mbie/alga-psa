'use client';

import React from 'react';
import { Alert, AlertDescription } from '@alga-psa/ui/components/Alert';
import { Button } from '@alga-psa/ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@alga-psa/ui/components/Card';
import Spinner from '@alga-psa/ui/components/Spinner';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import {
  applyPax8QuantityReconciliation,
  getPax8ReconciliationPreview,
  type Pax8ReconciliationPreviewRow,
  type Pax8ReconciliationStatus,
  type Pax8ProposedQuantityAction,
} from '../../../actions/integrations/pax8ReconciliationActions';
import Pax8CostPreview from './Pax8CostPreview';

function statusLabel(status: Pax8ReconciliationStatus): string {
  switch (status) {
    case 'unmapped-client': return 'Map customer';
    case 'unmapped-service': return 'Map product';
    case 'tracking-disabled': return 'Quantity tracking off';
    case 'no-contract-service': return 'Not on active contract';
    case 'ambiguous-contract': return 'Multiple contract matches';
    case 'ready': return 'Ready';
  }
}

function actionLabel(action: Pax8ProposedQuantityAction, row: Pax8ReconciliationPreviewRow): string {
  switch (action) {
    case 'map-client': return 'Map customer first';
    case 'map-service': return 'Map product first';
    case 'enable-tracking': return 'Enable quantity tracking';
    case 'add-to-contract': return 'Review contract membership';
    case 'resolve-contract': return `Resolve ${row.contractMatchCount} matches`;
    case 'no-change': return 'No change';
    case 'increase': return `Increase to ${row.vendorQuantity}`;
    case 'decrease': return `Decrease to ${row.vendorQuantity}`;
  }
}

function formatQuantity(value?: number | null): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function rowKey(row: Pax8ReconciliationPreviewRow): string {
  return `${row.externalClientId}:${row.externalProductId}`;
}

function isApplyEligible(row: Pax8ReconciliationPreviewRow): boolean {
  return row.status === 'ready'
    && row.psaQuantity !== null
    && row.psaQuantity !== undefined
    && row.quantityDelta !== null
    && row.quantityDelta !== undefined
    && row.quantityDelta !== 0;
}

export function Pax8ReconciliationPreview() {
  useTranslation('msp/integrations');
  const [loading, setLoading] = React.useState(true);
  const [applying, setApplying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Pax8ReconciliationPreviewRow[]>([]);
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getPax8ReconciliationPreview();
      if (!result.success) {
        setError(result.error || 'Failed to load Pax8 reconciliation preview');
        return;
      }
      setRows(result.rows || []);
      setSelectedKeys(new Set());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Pax8 reconciliation preview');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const readyRows = rows.filter((row) => row.status === 'ready');
  const mismatches = readyRows.filter((row) => row.quantityDelta !== 0);
  const attention = rows.filter((row) => row.status !== 'ready');
  const eligibleRows = rows.filter(isApplyEligible);
  const selectedRows = eligibleRows.filter((row) => selectedKeys.has(rowKey(row)));
  const allEligibleSelected = eligibleRows.length > 0 && selectedRows.length === eligibleRows.length;

  const toggleRow = React.useCallback((key: string, checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggleAllEligible = React.useCallback((checked: boolean) => {
    setSelectedKeys(checked ? new Set(eligibleRows.map(rowKey)) : new Set());
  }, [eligibleRows]);

  const applySelected = React.useCallback(async () => {
    if (selectedRows.length === 0) return;

    const confirmed = window.confirm(
      `Apply ${selectedRows.length} Pax8 quantity change${selectedRows.length === 1 ? '' : 's'} to AlgaPSA contract quantities?\n\nThis does not regenerate invoices or change service costs.`,
    );
    if (!confirmed) return;

    setApplying(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await applyPax8QuantityReconciliation(selectedRows.map((row) => ({
        externalClientId: row.externalClientId,
        externalProductId: row.externalProductId,
        expectedCapturedAt: row.capturedAt,
        expectedVendorQuantity: row.vendorQuantity,
        expectedPsaQuantity: row.psaQuantity as number,
      })));

      if (!result.success) {
        setError(result.error || 'Failed to apply Pax8 reconciliation');
        return;
      }

      const appliedCount = result.applied?.length ?? 0;
      setSuccess(`Applied ${appliedCount} contract quantity change${appliedCount === 1 ? '' : 's'}. Invoices and costs were not changed.`);
      await load();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Failed to apply Pax8 reconciliation');
    } finally {
      setApplying(false);
    }
  }, [load, selectedRows]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>Pax8 reconciliation preview</CardTitle>
              <CardDescription>
                Compare the latest Pax8 subscription quantities with active AlgaPSA contract service quantities, then explicitly apply selected differences.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                id="pax8-apply-reconciliation"
                type="button"
                onClick={() => void applySelected()}
                disabled={loading || applying || selectedRows.length === 0}
              >
                {applying && <Spinner size="xs" />}
                Apply selected quantities{selectedRows.length > 0 ? ` (${selectedRows.length})` : ''}
              </Button>
              <Button
                id="pax8-refresh-reconciliation-preview"
                type="button"
                variant="outline"
                onClick={() => void load()}
                disabled={loading || applying}
              >
                {loading ? <Spinner size="xs" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Refresh preview
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <Alert>
            <AlertDescription>
              Only selected Ready rows with a quantity difference can be applied. The server rechecks every row before writing and aborts the whole batch if Pax8 or AlgaPSA data changed. Invoice and cost writes remain disabled.
            </AlertDescription>
          </Alert>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert>
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ready to compare</p>
              <p className="mt-1 text-xl font-semibold">{readyRows.length}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Quantity differences</p>
              <p className="mt-1 text-xl font-semibold">{mismatches.length}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Needs attention</p>
              <p className="mt-1 text-xl font-semibold">{attention.length}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Selected to apply</p>
              <p className="mt-1 text-xl font-semibold">{selectedRows.length}</p>
            </div>
          </div>

          {loading && rows.length === 0 ? (
            <div className="flex items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
              <Spinner size="sm" />
              Loading reconciliation preview...
            </div>
          ) : rows.length === 0 ? (
            <Alert>
              <AlertDescription>Run a Pax8 read-only sync to create usage snapshots for reconciliation.</AlertDescription>
            </Alert>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[1180px] text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="w-12 px-4 py-3 font-medium">
                      <input
                        type="checkbox"
                        aria-label="Select all quantity differences"
                        checked={allEligibleSelected}
                        disabled={eligibleRows.length === 0 || applying}
                        onChange={(event) => toggleAllEligible(event.target.checked)}
                      />
                    </th>
                    <th className="px-4 py-3 font-medium">Client</th>
                    <th className="px-4 py-3 font-medium">Service</th>
                    <th className="px-4 py-3 text-right font-medium">Alga Qty</th>
                    <th className="px-4 py-3 text-right font-medium">Pax8 Qty</th>
                    <th className="px-4 py-3 text-right font-medium">Difference</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Proposed change</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => {
                    const key = rowKey(row);
                    const eligible = isApplyEligible(row);
                    return (
                      <tr key={key}>
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${row.externalClientName} ${row.externalProductName}`}
                            checked={selectedKeys.has(key)}
                            disabled={!eligible || applying}
                            onChange={(event) => toggleRow(key, event.target.checked)}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{row.clientName || row.externalClientName}</div>
                          {!row.clientName && <div className="text-xs text-muted-foreground">Pax8: {row.externalClientName}</div>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium">{row.serviceName || row.externalProductName}</div>
                          <div className="text-xs text-muted-foreground">{row.externalSku || row.externalProductName}</div>
                          {row.contractLineName && <div className="text-xs text-muted-foreground">Contract line: {row.contractLineName}</div>}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">{formatQuantity(row.psaQuantity)}</td>
                        <td className="px-4 py-3 text-right font-medium">{formatQuantity(row.vendorQuantity)}</td>
                        <td className="px-4 py-3 text-right font-medium">
                          {row.quantityDelta === null || row.quantityDelta === undefined
                            ? '—'
                            : row.quantityDelta > 0
                              ? `+${formatQuantity(row.quantityDelta)}`
                              : formatQuantity(row.quantityDelta)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-full border px-2 py-1 text-xs">{statusLabel(row.status)}</span>
                        </td>
                        <td className="px-4 py-3">{actionLabel(row.proposedAction, row)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Pax8CostPreview />
    </div>
  );
}

export default Pax8ReconciliationPreview;
