'use client';

import React from 'react';
import { Alert, AlertDescription } from '@alga-psa/ui/components/Alert';
import { Button } from '@alga-psa/ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@alga-psa/ui/components/Card';
import Spinner from '@alga-psa/ui/components/Spinner';
import { RefreshCw } from 'lucide-react';
import { useToast } from '@alga-psa/ui/hooks/use-toast';
import type { IClient, IService, IVendorClientMapping, IVendorServiceMapping } from '@alga-psa/types';
import { getIntegrationClients } from '../../../actions/clientLookupActions';
import { getServices } from '../../../actions/serviceCatalogActions';
import {
  listPax8Mappings,
  mapPax8Client,
  mapPax8Service,
} from '../../../actions/integrations/pax8MappingActions';

function mappingLabel(status: IVendorClientMapping['mapping_status'] | IVendorServiceMapping['mapping_status']): string {
  if (status === 'mapped') return 'Mapped';
  if (status === 'ignored') return 'Ignored';
  return 'Unmapped';
}

export function Pax8MappingSettings() {
  const { toast } = useToast();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [clients, setClients] = React.useState<IClient[]>([]);
  const [services, setServices] = React.useState<IService[]>([]);
  const [clientMappings, setClientMappings] = React.useState<IVendorClientMapping[]>([]);
  const [serviceMappings, setServiceMappings] = React.useState<IVendorServiceMapping[]>([]);
  const [savingKeys, setSavingKeys] = React.useState<Set<string>>(new Set());

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
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
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
              <table className="w-full min-w-[760px] text-sm">
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
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-full border px-2 py-1 text-xs">{mappingLabel(mapping.mapping_status)}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
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
          <CardTitle>Product mapping</CardTitle>
          <CardDescription>
            Match Pax8 products to your existing AlgaPSA service catalog. These settings only prepare future reconciliation; billing writes remain disabled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {serviceMappings.length === 0 ? (
            <Alert>
              <AlertDescription>Run the Pax8 read-only sync first. Products referenced by your subscriptions will appear here.</AlertDescription>
            </Alert>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[980px] text-sm">
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
    </div>
  );
}

export default Pax8MappingSettings;
