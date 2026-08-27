'use client';

import React from 'react';
import { Alert, AlertDescription } from '@alga-psa/ui/components/Alert';
import { Button } from '@alga-psa/ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@alga-psa/ui/components/Card';
import Spinner from '@alga-psa/ui/components/Spinner';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import {
  getPax8CostPreview,
  type Pax8CostPreviewRow,
  type Pax8CostPreviewStatus,
} from '../../../actions/integrations/pax8CostActions';

function statusLabel(status: Pax8CostPreviewStatus): string {
  switch (status) {
    case 'unmapped-client': return 'Map customer';
    case 'unmapped-service': return 'Map product';
    case 'tracking-disabled': return 'Cost tracking off';
    case 'no-contract-service': return 'Not on active contract';
    case 'ambiguous-contract': return 'Multiple contract matches';
    case 'pricing-unresolved': return 'Pricing unresolved';
    case 'zero-rate-review': return 'Review zero-rate pricing';
    case 'ready': return 'Ready';
  }
}

function formatMajor(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch {
      // Fall through to plain numeric formatting for unknown currency codes.
    }
  }
  return value.toFixed(2);
}

function formatCents(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return formatMajor(value / 100, currency);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toFixed(1)}%`;
}

export function Pax8CostPreview() {
  useTranslation('msp/integrations');
  const [loading, setLoading] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Pax8CostPreviewRow[]>([]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getPax8CostPreview();
      if (!result.success) {
        setError(result.error || 'Failed to load Pax8 cost preview');
        return;
      }
      setRows(result.rows || []);
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Pax8 cost preview');
    } finally {
      setLoading(false);
    }
  }, []);

  const readyRows = rows.filter((row) => row.status === 'ready');
  const negativeMarginRows = readyRows.filter((row) => (row.marginPerUnitCents ?? 0) < 0);
  const attentionRows = rows.filter((row) => row.status !== 'ready');

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Pax8 cost & margin preview</CardTitle>
            <CardDescription>
              Pull current company-specific Pax8 partner pricing and compare it with the mapped AlgaPSA catalog cost and active contract sell rate.
            </CardDescription>
          </div>
          <Button
            id="pax8-refresh-cost-preview"
            type="button"
            variant="outline"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? <Spinner size="xs" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {loaded ? 'Refresh live costs' : 'Load live costs'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <Alert>
          <AlertDescription>
            This view is read-only. It does not change service costs, contract rates, invoices, or Pax8 pricing. Only products with Cost tracking enabled are queried.
          </AlertDescription>
        </Alert>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!loaded && !loading ? (
          <Alert>
            <AlertDescription>
              Click Load live costs when you want a current margin check. Pax8 pricing is dynamic, so it is fetched on demand rather than cached as authoritative pricing.
            </AlertDescription>
          </Alert>
        ) : null}

        {loaded && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ready</p>
                <p className="mt-1 text-xl font-semibold">{readyRows.length}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Negative margin</p>
                <p className="mt-1 text-xl font-semibold">{negativeMarginRows.length}</p>
              </div>
              <div className="rounded-lg border p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Needs attention</p>
                <p className="mt-1 text-xl font-semibold">{attentionRows.length}</p>
              </div>
            </div>

            {rows.length === 0 ? (
              <Alert>
                <AlertDescription>
                  No mapped Pax8 products currently have Cost tracking enabled. Enable Cost → Track in Product mapping first.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[1320px] text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-4 py-3 font-medium">Client</th>
                      <th className="px-4 py-3 font-medium">Service</th>
                      <th className="px-4 py-3 text-right font-medium">Qty</th>
                      <th className="px-4 py-3 text-right font-medium">Pax8 cost</th>
                      <th className="px-4 py-3 text-right font-medium">Alga cost</th>
                      <th className="px-4 py-3 text-right font-medium">Sell rate</th>
                      <th className="px-4 py-3 text-right font-medium">Margin / unit</th>
                      <th className="px-4 py-3 text-right font-medium">Margin %</th>
                      <th className="px-4 py-3 font-medium">Status</th>
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
                        <td className="px-4 py-3 text-right">{row.quantity}</td>
                        <td className="px-4 py-3 text-right font-medium">
                          {formatMajor(row.pax8PartnerBuyRate, row.pax8Currency)}
                          {row.pax8BillingTerm && <div className="text-xs font-normal text-muted-foreground">{row.pax8BillingTerm}</div>}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {formatCents(row.algaCatalogCostCents, row.algaCatalogCostCurrency)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {formatCents(row.algaSellRateCents, row.algaSellRateCurrency)}
                          {row.algaSellRateSource && <div className="text-xs font-normal text-muted-foreground">{row.algaSellRateSource}</div>}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">
                          {formatCents(row.marginPerUnitCents, row.algaSellRateCurrency)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium">{formatPercent(row.marginPercent)}</td>
                        <td className="px-4 py-3">
                          <span className="rounded-full border px-2 py-1 text-xs">{statusLabel(row.status)}</span>
                          {row.detail && <div className="mt-2 max-w-[280px] text-xs text-muted-foreground">{row.detail}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default Pax8CostPreview;
