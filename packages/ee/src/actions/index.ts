/*
 * Community Edition facade for @alga-psa/ee-microsoft-teams/actions.
 *
 * The Community Next/Turbopack resolver aliases
 *   @alga-psa/ee-microsoft-teams/* -> packages/ee/src/*
 * so shared integrations code may safely reference the public EE action
 * contract without bundling Enterprise implementation code.
 *
 * These functions are intentionally inert. Teams availability gates prevent
 * them from being used for an active CE integration, but keeping a complete
 * facade lets shared source compile and render in Community Edition.
 */

const unavailable = 'Microsoft Teams integration requires Enterprise Edition';

export async function runTeamsDiagnosticsImpl(..._args: any[]): Promise<any> {
  return { success: false, error: unavailable, steps: [] };
}

export async function sendTeamsTestMessageImpl(..._args: any[]): Promise<any> {
  return { success: false, error: unavailable };
}

export async function validateTeamsGraphCredentialsImpl(..._args: any[]): Promise<any> {
  return { success: false, error: unavailable };
}

export async function probeTeamsGraphPermissionsImpl(..._args: any[]): Promise<any> {
  return { success: false, error: unavailable, permissions: [] };
}

export async function validateTeamsBotConnectorImpl(..._args: any[]): Promise<any> {
  return { success: false, error: unavailable };
}

export async function listTeamsDeliveriesImpl(..._args: any[]): Promise<any> {
  return { success: false, error: unavailable, rows: [], total: 0 };
}

export async function listTeamsAuditEventsImpl(..._args: any[]): Promise<any> {
  return { success: false, error: unavailable, rows: [], total: 0 };
}

/**
 * Compatibility helper used by shared integration loaders in some builds.
 * Keeping this synchronous mirrors a facade/registry lookup rather than a
 * server action invocation.
 */
export function getTeamsActionImplementations() {
  return {
    runTeamsDiagnosticsImpl,
    sendTeamsTestMessageImpl,
    validateTeamsGraphCredentialsImpl,
    probeTeamsGraphPermissionsImpl,
    validateTeamsBotConnectorImpl,
    listTeamsDeliveriesImpl,
    listTeamsAuditEventsImpl,
  };
}
