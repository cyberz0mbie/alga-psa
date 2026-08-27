'use client';

import React from 'react';
import { Alert, AlertDescription } from '@alga-psa/ui/components/Alert';
import { Button } from '@alga-psa/ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@alga-psa/ui/components/Card';
import Spinner from '@alga-psa/ui/components/Spinner';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useToast } from '@alga-psa/ui/hooks/use-toast';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import type { IClient, IService, IVendorClientMapping, IVendorServiceMapping } from '@alga-psa/types';
import { getIntegrationClients } from '../../../actions/clientLookupActions';
import { getServices } from '../../../actions/serviceCatalogActions';
import {
  listPax8Mappings,
  mapPax8Client,
  mapPax8Service,
} from '../../../actions/integrations/pax8MappingActions';
import Pax8ReconciliationPreview from './Pax8ReconciliationPreview';

interface MatchSuggestion<T> {
  item: T;
  score: number;
  exact: boolean;
}

function mappingLabel(status: IVendorClientMapping['mapping_status'] | IVendorServiceMapping['mapping_status']): string {
  if (status === 'mapped') return 'Mapped';
  if (status === 'ignored') return 'Ignored';
  return 'Unmapped';
}

function normalizeMatchValue(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeProductName(value: string): string {
  return normalizeMatchValue(
    value
      .replace(/\[\s*new commerce experience\s*\]/gi, ' ')
      .replace(/\bnew commerce experience\b/gi, ' '),
  );
}

function tokenSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

function bestSuggestion<T>(
  source: string,
  candidates: T[],
  label: (candidate: T) => string,
  normalize: (value: string) => string,
  threshold: number,
): MatchSuggestion<T> | null {
  const normalizedSource = normalize(source);
  if (!normalizedSource) return null;

  let best: MatchSuggestion<T> | null = null;
  for (const candidate of candidates) {
    const normalizedCandidate = normalize(label(candidate));
    if (!normalizedCandidate) continue;
    const exact = normalizedCandidate === normalizedSource;
    const score = exact ? 1 : tokenSimilarity(normalizedSource, normalizedCandidate);
    if (score < threshold) continue;
    if (!best || score > best.score) {
      best = { item: candidate, score, exact };
    }
  }

  return best;
}

export function Pax8MappingSettings() {
  const { toast } = useToast();
  // Keep this component registered with the integrations namespace while the
  // initial Pax8 UI copy is stabilized. Full key coverage will follow after
  // the read-only workflow is verified against a live tenant.
  useTranslation('msp/integrations');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [clients, setClients] = React.useState<IClient[]>([]);
  const [services, setServices] = React.useState<IService[]>([]);
  const [clientMappings, setClientMappings] = React.useState<IVendorClientMapping[]>([]);
  const [serviceMappings, setServiceMappings] = React.useState<IVendorServiceMapping[]>([]);
  const [savingKeys, setSavingKeys] = React.useState<Set<string>>(new Set());
  const [autoMatchingClients, setAutoMatchingClients] = React.useState(false);
  const [autoMatchingServices, setAutoMatchingServices] = React.useState(false);

  const setSaving = React.useCallback((key: string, saving: boolean) => {
    setSavingKeys((current) => {
      const next = new Set(current);
      if (saving) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mappingResult, clientResult, serviceResult] = await Promise.all([
        listPax8Mappings(),
        getIntegrationClients(false),
        getServices(1, 999, { item_kind: 'any' }),
      ]);

      if (!mappingResult.success) {
        setError(mappingResult.error || 'Failed to load Pax8 mappings');
        return;
      }

      setClientMappings(mappingResult.clientMappings || []);
      setServiceMappings(mappingResult.serviceMappings || []);
      setClients(clientResult || []);
      setServices(serviceResult.services || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Pax8 mappings');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const clientSuggestion = React.useCallback((mapping: IVendorClientMapping) => (
    bestSuggestion(
      mapping.external_client_name,
      clients,
      (client) => client.client_name,
      normalizeMatchValue,
      0.72,
    )
  ), [clients]);

  const serviceSuggestion = React.useCallback((mapping: IVendorServiceMapping) => (
    bestSuggestion(
      mapping.external_product_name,
      services,
      (service) => service.service_name,
      normalizeProductName,
      0.68,
    )
  ), [services]);

  const saveClientMapping = async (mapping: IVendorClientMapping, clientId: string | null, ignore = false) => {
    const key = `client:${mapping.external_client_id}`;
    setSaving(key, true);
    try {
      const result = await mapPax8Client({
        externalClientId: mapping.external_client_id,
        clientId,
        ignore,
      });

      if (!result.success || !result.mapping) {
        const message = result.error || 'Failed to update Pax8 customer mapping';
        toast({ title: 'Mapping failed', description: message, variant: 'destructive' });
        return;
      }

      setClientMappings((current) => current.map((item) =>
        item.external_client_id === mapping.external_client_id ? result.mapping! : item
      ));
    } finally {
      setSaving(key, false);
    }
  };

  const saveServiceMapping = async (
    mapping: IVendorServiceMapping,
    patch: {
      serviceId?: string | null;
      ignore?: boolean;
      syncQuantity?: boolean;
      syncCost?: boolean;
    },
  ) => {
    const key = `service:${mapping.external_product_id}`;
    setSaving(key, true);
    try {
      const nextServiceId = patch.serviceId === undefined ? mapping.service_id ?? null : patch.serviceId;
      const result = await mapPax8Service({
        externalProductId: mapping.external_product_id,
        serviceId: nextServiceId,
        ignore: patch.ignore,
        syncQuantity: patch.syncQuantity === undefined ? mapping.sync_quantity : patch.syncQuantity,
        syncCost: patch.syncCost === undefined ? mapping.sync_cost : patch.syncCost,
      });

      if (!result.success || !result.mapping) {
        const message = result.error || 'Failed to update Pax8 product mapping';
        toast({ title: 'Mapping failed', description: message, variant: 'destructive' });
        return;
      }

      setServiceMappings((current) => current.map((item) =>
        item.external_product_id === mapping.external_product_id ? result.mapping! : item
      ));
    } finally {
      setSaving(key, false);
    }
  };

  const autoMatchExactClients = async () => {
    const matches = clientMappings
      .filter((mapping) => mapping.mapping_status === 'unmapped')
      .map((mapping) => ({ mapping, suggestion: clientSuggestion(mapping) }))
      .filter((entry): entry is { mapping: IVendorClientMapping; suggestion: MatchSuggestion<IClient> } =>
        Boolean(entry.suggestion?.exact));

    if (matches.length === 0) {
      toast({ title: 'No exact customer matches', description: 'Fuzzy suggestions are shown for manual review.' });
      return;
    }

    setAutoMatchingClients(true);
    try {
      const results = await Promise.all(matches.map(async ({ mapping, suggestion }) => (
        mapPax8Client({
          externalClientId: mapping.external_client_id,
          clientId: suggestion.item.client_id,
          ignore: false,
        })
      )));
      const updated = new Map<string, IVendorClientMapping>();
      results.forEach((result) => {
        if (result.success && result.mapping) updated.set(result.mapping.external_client_id, result.mapping);
      });
      setClientMappings((current) => current.map((mapping) => updated.get(mapping.external_client_id) || mapping));
      toast({ title: 'Exact customer matches applied', description: `${updated.size} customer mapping(s) updated.` });
    } finally {
      setAutoMatchingClients(false);
    }
  };

  const autoMatchExactServices = async () => {
    const matches = serviceMappings
      .filter((mapping) => mapping.mapping_status === 'unmapped')
      .map((mapping) => ({ mapping, suggestion: serviceSuggestion(mapping) }))
      .filter((entry): entry is { mapping: IVendorServiceMapping; suggestion: MatchSuggestion<IService> } =>
        Boolean(entry.suggestion?.exact));

    if (matches.length === 0) {
      toast({ title: 'No exact product matches', description: 'Fuzzy suggestions are shown for manual review.' });
      return;
    }

    setAutoMatchingServices(true);
    try {
      const results = await Promise.all(matches.map(async ({ mapping, suggestion }) => (
        mapPax8Service({
          externalProductId: mapping.external_product_id,
          serviceId: suggestion.item.service_id,
          ignore: false,
          syncQuantity: mapping.sync_quantity,
          syncCost: mapping.sync_cost,
        })
      )));
      const updated = new Map<string, IVendorServiceMapping>();
      results.forEach((result) => {
        if (result.success && result.mapping) updated.set(result.mapping.external_product_id, result.mapping);
      });
      setServiceMappings((current) => current.map((mapping) => updated.get(mapping.external_product_id) || mapping));
      toast({ title: 'Exact product matches applied', description: `${updated.size} product mapping(s) updated.` });
    } finally {
      setAutoMatchingServices(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-10">
          <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <Spinner size="sm" />
            Loading Pax8 mappings...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>Customer mapping</CardTitle>
              <CardDescription>
                Match each Pax8 customer to the existing AlgaPSA client that should own its subscriptions.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                id="pax8-auto-match-exact-clients"
                type="button"
                variant="outline"
                onClick={() => void autoMatchExactClients()}
                disabled={autoMatchingClients || clients.length === 0}
              >
                {autoMatchingClients ? <Spinner size="xs" /> : <Sparkles className="mr-2 h-4 w-4" />}
                Auto-match exact
              </Button>
              <Button id="pax8-refresh-mappings" type="button" variant="outline" onClick={() => void load()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {clientMappings.length === 0 ? (
            <Alert>
              <AlertDescription>Run the Pax8 read-only sync first. Discovered customers will appear here for mapping.</AlertDescription>
            </Alert>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Pax8 customer</th>
                    <th className="px-4 py-3 font-medium">AlgaPSA client</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {clientMappings.map((mapping) => {
                    const key = `client:${mapping.external_client_id}`;
                    const saving = savingKeys.has(key);
                    const suggestion = mapping.mapping_status === 'unmapped' ? clientSuggestion(mapping) : null;
                    return (
                      <tr key={mapping.mapping_id}>
                        <td className="px-4 py-3">
                          <div className="font-medium">{mapping.external_client_name}</div>
                          <div className="text-xs text-muted-foreground">{mapping.external_client_id}</div>
                        </td>
                        <td className="px-4 py-3">
                          <select
                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={mapping.mapping_status === 'ignored' ? '' : mapping.client_id ?? ''}
                            disabled={saving || mapping.mapping_status === 'ignored'}
                            onChange={(event) => void saveClientMapping(mapping, event.target.value || null)}
                          >
                            <option value="">Not mapped</option>
                            {clients.map((client) => (
                              <option key={client.client_id} value={client.client_id}>{client.client_name}</option>
                            ))}
                          </select>
                          {suggestion && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>
                                Suggested: {suggestion.item.client_name} ({Math.round(suggestion.score * 100)}%)
                              </span>
                              <Button
                                id={`pax8-use-client-suggestion-${mapping.mapping_id}`}
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={saving}
                                onClick={() => void saveClientMapping(mapping, suggestion.item.client_id)}
                              >
                                Use suggestion
                              </Button>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-full border px-2 py-1 text-xs">{mappingLabel(mapping.mapping_status)}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            id={`pax8-client-map-action-${mapping.mapping_id}`}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={saving}
                            onClick={() => void saveClientMapping(mapping, null, mapping.mapping_status !== 'ignored')}
                          >
                            {saving ? <Spinner size="xs" /> : mapping.mapping_status === 'ignored' ? 'Restore' : 'Ignore'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle>Product mapping</CardTitle>
              <CardDescription>
                Match Pax8 products to your existing AlgaPSA service catalog. These settings only prepare future reconciliation; billing writes remain disabled.
              </CardDescription>
            </div>
            <Button
              id="pax8-auto-match-exact-services"
              type="button"
              variant="outline"
              onClick={() => void autoMatchExactServices()}
              disabled={autoMatchingServices || services.length === 0}
            >
              {autoMatchingServices ? <Spinner size="xs" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Auto-match exact
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {serviceMappings.length === 0 ? (
            <Alert>
              <AlertDescription>Run the Pax8 read-only sync first. Products referenced by your subscriptions will appear here.</AlertDescription>
            </Alert>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[1040px] text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-4 py-3 font-medium">Pax8 product</th>
                    <th className="px-4 py-3 font-medium">AlgaPSA service</th>
                    <th className="px-4 py-3 font-medium">Quantity</th>
                    <th className="px-4 py-3 font-medium">Cost</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {serviceMappings.map((mapping) => {
                    const key = `service:${mapping.external_product_id}`;
                    const saving = savingKeys.has(key);
                    const ignored = mapping.mapping_status === 'ignored';
                    const suggestion = mapping.mapping_status === 'unmapped' ? serviceSuggestion(mapping) : null;
                    return (
                      <tr key={mapping.mapping_id}>
                        <td className="px-4 py-3">
                          <div className="font-medium">{mapping.external_product_name}</div>
                          <div className="text-xs text-muted-foreground">{mapping.external_sku || mapping.external_product_id}</div>
                        </td>
                        <td className="px-4 py-3">
                          <select
                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={ignored ? '' : mapping.service_id ?? ''}
                            disabled={saving || ignored}
                            onChange={(event) => void saveServiceMapping(mapping, { serviceId: event.target.value || null })}
                          >
                            <option value="">Not mapped</option>
                            {services.map((service) => (
                              <option key={service.service_id} value={service.service_id}>{service.service_name}</option>
                            ))}
                          </select>
                          {suggestion && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>
                                Suggested: {suggestion.item.service_name} ({Math.round(suggestion.score * 100)}%)
                              </span>
                              <Button
                                id={`pax8-use-service-suggestion-${mapping.mapping_id}`}
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={saving}
                                onClick={() => void saveServiceMapping(mapping, { serviceId: suggestion.item.service_id })}
                              >
                                Use suggestion
                              </Button>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={!ignored && mapping.sync_quantity}
                              disabled={saving || ignored || !mapping.service_id}
                              onChange={(event) => void saveServiceMapping(mapping, { syncQuantity: event.target.checked })}
                            />
                            <span className="text-xs">Track</span>
                          </label>
                        </td>
                        <td className="px-4 py-3">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={!ignored && mapping.sync_cost}
                              disabled={saving || ignored || !mapping.service_id}
                              onChange={(event) => void saveServiceMapping(mapping, { syncCost: event.target.checked })}
                            />
                            <span className="text-xs">Track</span>
                          </label>
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-full border px-2 py-1 text-xs">{mappingLabel(mapping.mapping_status)}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            id={`pax8-service-map-action-${mapping.mapping_id}`}
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={saving}
                            onClick={() => void saveServiceMapping(mapping, {
                              serviceId: ignored ? null : mapping.service_id ?? null,
                              ignore: !ignored,
                              syncQuantity: ignored ? false : mapping.sync_quantity,
                              syncCost: ignored ? false : mapping.sync_cost,
                            })}
                          >
                            {saving ? <Spinner size="xs" /> : ignored ? 'Restore' : 'Ignore'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Pax8ReconciliationPreview />
    </div>
  );
}

export default Pax8MappingSettings;
