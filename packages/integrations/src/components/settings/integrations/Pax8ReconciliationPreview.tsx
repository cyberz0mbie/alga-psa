'use client';

import React from 'react';
import { Alert, AlertDescription } from '@alga-psa/ui/components/Alert';
import { Button } from '@alga-psa/ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@alga-psa/ui/components/Card';
import Spinner from '@alga-psa/ui/components/Spinner';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import {
  getPax8ReconciliationPreview,
  type Pax8ReconciliationPreviewRow,
  type Pax8ReconciliationStatus,
  type Pax8ProposedQuantityAction,
} from '../../../actions/integrations/pax8ReconciliationActions';

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

export function Pax8ReconciliationPreview() {
  useTranslation('msp/integrations');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Pax8ReconciliationPreviewRow[]>([]);

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

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Pax8 reconciliation preview</CardTitle>
            <CardDescription>
              Compare the latest Pax8 subscription quantities with active AlgaPSA contract service quantities. This view is read-only.
            </CardDescription>
          </div>
          <Button id="pax8-refresh-reconciliation-preview" type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner size="xs" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh preview
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <Alert>
          <AlertDescription>
            No contract quantities are changed from this screen. Rows with multiple active contract matches are deliberately left unresolved.
          </AlertDescription>
        </Alert>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
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
            <table className="w-full min-w-[1120px] text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
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
                {rows.map((row) => (
                  <tr key={`${row.externalClientId}:${row.externalProductId}`}>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default Pax8ReconciliationPreview;
