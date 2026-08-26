'use client';

import React from 'react';
import { Alert, AlertDescription } from '@alga-psa/ui/components/Alert';
import { Button } from '@alga-psa/ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@alga-psa/ui/components/Card';
import { Input } from '@alga-psa/ui/components/Input';
import { Label } from '@alga-psa/ui/components/Label';
import Spinner from '@alga-psa/ui/components/Spinner';
import { Eye, EyeOff, RefreshCw, Save, Unlink } from 'lucide-react';
import { useToast } from '@alga-psa/ui/hooks/use-toast';
import { useTranslation } from '@alga-psa/ui/lib/i18n/client';
import {
  disconnectPax8Integration,
  getPax8Settings,
  savePax8Configuration,
  syncPax8ReadOnly,
  testPax8Connection,
} from '../../../actions/integrations/pax8Actions';

function statusLabel(status?: string | null): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
}

function formatTimestamp(value?: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function Pax8IntegrationSettings() {
  const { toast } = useToast();
  // Keep this component registered with the integrations namespace while the
  // initial Pax8 UI copy is stabilized. Full key coverage will follow after
  // the read-only workflow is verified against a live tenant.
  useTranslation('msp/integrations');

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [showClientId, setShowClientId] = React.useState(false);
  const [showClientSecret, setShowClientSecret] = React.useState(false);

  const [settings, setSettings] = React.useState<Awaited<ReturnType<typeof getPax8Settings>> | null>(null);
  const [syncResult, setSyncResult] = React.useState<Awaited<ReturnType<typeof syncPax8ReadOnly>>['result'] | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getPax8Settings();
      setSettings(result);
      if (!result.success) {
        setError(result.error || 'Failed to load Pax8 settings');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Pax8 settings');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const hasClientId = Boolean(settings?.credentials?.hasClientId);
  const hasClientSecret = Boolean(settings?.credentials?.hasClientSecret);
  const effectiveClientId = clientId.trim().length > 0 || hasClientId;
  const effectiveClientSecret = clientSecret.trim().length > 0 || hasClientSecret;
  const canSave = effectiveClientId && effectiveClientSecret;
  const isConfigured = hasClientId && hasClientSecret;
  const isConnected = settings?.integration?.status === 'connected';

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await savePax8Configuration({
        clientId: clientId.trim() || undefined,
        clientSecret: clientSecret.trim() || undefined,
      });

      if (!result.success) {
        const message = result.error || 'Failed to save Pax8 credentials';
        setError(message);
        toast({ title: 'Pax8 save failed', description: message, variant: 'destructive' });
        return;
      }

      setClientId('');
      setClientSecret('');
      setSuccess('Pax8 credentials saved. Test the connection before syncing.');
      toast({ title: 'Pax8 saved', description: 'Credentials were stored securely.' });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await testPax8Connection();
      if (!result.success) {
        const message = result.error || 'Pax8 connection test failed';
        setError(message);
        toast({ title: 'Pax8 connection failed', description: message, variant: 'destructive' });
        return;
      }

      setSuccess('Pax8 connection verified successfully.');
      toast({ title: 'Pax8 connected', description: 'The API credentials were verified.' });
      await load();
    } finally {
      setTesting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    setSuccess(null);
    setSyncResult(null);
    try {
      const result = await syncPax8ReadOnly();
      if (!result.success) {
        const message = result.error || 'Pax8 synchronization failed';
        setError(message);
        toast({ title: 'Pax8 sync failed', description: message, variant: 'destructive' });
        return;
      }

      setSyncResult(result.result || null);
      setSuccess('Read-only Pax8 synchronization completed. No contracts or invoices were changed.');
      toast({ title: 'Pax8 sync complete', description: 'Vendor data was imported for mapping and reconciliation.' });
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError(null);
    setSuccess(null);
    setSyncResult(null);
    try {
      const result = await disconnectPax8Integration();
      if (!result.success) {
        const message = result.error || 'Failed to disconnect Pax8';
        setError(message);
        toast({ title: 'Disconnect failed', description: message, variant: 'destructive' });
        return;
      }

      setClientId('');
      setClientSecret('');
      setSuccess('Pax8 credentials removed. Existing mapping and usage history was retained.');
      toast({ title: 'Pax8 disconnected', description: 'Stored Pax8 credentials were removed.' });
      await load();
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-10">
          <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <Spinner size="sm" />
            Loading Pax8 settings...
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
              <CardTitle>Pax8</CardTitle>
              <CardDescription>
                Import customers, subscribed products, quantities, and vendor usage for reconciliation with AlgaPSA.
              </CardDescription>
            </div>
            <div className="rounded-full border px-3 py-1 text-xs font-medium">
              {statusLabel(settings?.integration?.status)}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <Alert>
            <AlertDescription>
              Pax8 is currently read-only. Syncing discovers customers and products and records subscription quantities, but it does not update contracts, prices, or invoices.
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

          <div className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pax8-client-id">Client ID</Label>
              <div className="flex gap-2">
                <Input
                  id="pax8-client-id"
                  type={showClientId ? 'text' : 'password'}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder={settings?.credentials?.clientIdMasked || (hasClientId ? 'Saved' : 'Enter Pax8 client ID')}
                  autoComplete="off"
                />
                <Button
                  id="pax8-toggle-client-id-visibility"
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowClientId((current) => !current)}
                  aria-label={showClientId ? 'Hide client ID' : 'Show client ID'}
                >
                  {showClientId ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {hasClientId && <p className="text-xs text-muted-foreground">A client ID is already stored. Leave blank to keep it.</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="pax8-client-secret">Client Secret</Label>
              <div className="flex gap-2">
                <Input
                  id="pax8-client-secret"
                  type={showClientSecret ? 'text' : 'password'}
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  placeholder={settings?.credentials?.clientSecretMasked || (hasClientSecret ? 'Saved' : 'Enter Pax8 client secret')}
                  autoComplete="new-password"
                />
                <Button
                  id="pax8-toggle-client-secret-visibility"
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setShowClientSecret((current) => !current)}
                  aria-label={showClientSecret ? 'Hide client secret' : 'Show client secret'}
                >
                  {showClientSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {hasClientSecret && <p className="text-xs text-muted-foreground">A client secret is already stored. Leave blank to keep it.</p>}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button id="pax8-save-credentials" type="button" onClick={handleSave} disabled={!canSave || saving}>
              {saving ? <Spinner size="xs" /> : <Save className="mr-2 h-4 w-4" />}
              Save credentials
            </Button>
            <Button id="pax8-test-connection" type="button" variant="outline" onClick={handleTest} disabled={!isConfigured || testing}>
              {testing ? <Spinner size="xs" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Test connection
            </Button>
            <Button id="pax8-disconnect" type="button" variant="outline" onClick={handleDisconnect} disabled={!isConfigured || disconnecting}>
              {disconnecting ? <Spinner size="xs" /> : <Unlink className="mr-2 h-4 w-4" />}
              Disconnect
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Discovery and usage sync</CardTitle>
          <CardDescription>
            Pull the latest Pax8 companies, subscribed products, and subscription quantities into the reconciliation staging tables.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last sync</p>
              <p className="mt-1 text-sm font-medium">{formatTimestamp(settings?.integration?.lastSyncAt)}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sync status</p>
              <p className="mt-1 text-sm font-medium">{settings?.integration?.lastSyncStatus || 'Not run'}</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Billing writes</p>
              <p className="mt-1 text-sm font-medium">Disabled</p>
            </div>
          </div>

          {settings?.integration?.lastError && (
            <Alert variant="destructive">
              <AlertDescription>{settings.integration.lastError}</AlertDescription>
            </Alert>
          )}

          {syncResult && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Companies</p>
                <p className="text-lg font-semibold">{syncResult.companiesSeen}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Products</p>
                <p className="text-lg font-semibold">{syncResult.productsSeen}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Subscriptions</p>
                <p className="text-lg font-semibold">{syncResult.subscriptionsSeen}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Usage snapshots</p>
                <p className="text-lg font-semibold">{syncResult.usageSnapshotsCreated}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Skipped</p>
                <p className="text-lg font-semibold">{syncResult.skippedSubscriptions}</p>
              </div>
            </div>
          )}

          <Button id="pax8-run-read-only-sync" type="button" onClick={handleSync} disabled={!isConnected || syncing}>
            {syncing ? <Spinner size="xs" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Run read-only sync
          </Button>

          {!isConnected && isConfigured && (
            <p className="text-sm text-muted-foreground">Test the Pax8 connection successfully before running a sync.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default Pax8IntegrationSettings;