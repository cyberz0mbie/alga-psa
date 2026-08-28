import { isEnterprise } from '@alga-psa/core';

export const CALENDAR_SETTINGS_CATEGORY = 'calendar';
export const IT_DOCUMENTATION_SETTINGS_CATEGORY = 'it-documentation';
export const VENDORS_SETTINGS_CATEGORY = 'vendors';
export const CALENDAR_PROFILE_TAB = 'calendar';

const BASE_INTEGRATION_CATEGORY_IDS = [
  'accounting',
  'rmm',
  VENDORS_SETTINGS_CATEGORY,
  'communication',
  'providers',
  'identity',
  'payments',
] as const;

const BASE_PROFILE_TABS = ['profile', 'security', 'single-sign-on', 'api-keys', 'notifications', 'keyboard-shortcuts'] as const;

export function isCalendarEnterpriseEdition(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env === process.env) {
    return isEnterprise;
  }

  const edition = (env.EDITION ?? '').toLowerCase();
  const publicEdition = (env.NEXT_PUBLIC_EDITION ?? '').toLowerCase();

  return edition === 'ee' || edition === 'enterprise' || publicEdition === 'enterprise';
}

export function getVisibleIntegrationCategoryIds(isEnterpriseEdition = isCalendarEnterpriseEdition()): string[] {
  if (!isEnterpriseEdition) {
    return [...BASE_INTEGRATION_CATEGORY_IDS];
  }

  return [
    'accounting',
    'rmm',
    IT_DOCUMENTATION_SETTINGS_CATEGORY,
    VENDORS_SETTINGS_CATEGORY,
    'communication',
    CALENDAR_SETTINGS_CATEGORY,
    'providers',
    'identity',
    'payments',
  ];
}

export function resolveIntegrationSettingsCategory(
  requestedCategory: string | null | undefined,
  isEnterpriseEdition = isCalendarEnterpriseEdition()
): string {
  const visibleCategoryIds = getVisibleIntegrationCategoryIds(isEnterpriseEdition);

  if (requestedCategory && visibleCategoryIds.includes(requestedCategory)) {
    return requestedCategory;
  }

  return visibleCategoryIds[0] ?? 'accounting';
}

export function getVisibleUserProfileTabs(isEnterpriseEdition = isCalendarEnterpriseEdition()): string[] {
  return isEnterpriseEdition ? [...BASE_PROFILE_TABS, CALENDAR_PROFILE_TAB] : [...BASE_PROFILE_TABS];
}

export function resolveUserProfileTab(
  requestedTab: string | null | undefined,
  isEnterpriseEdition = isCalendarEnterpriseEdition()
): string {
  const visibleTabs = getVisibleUserProfileTabs(isEnterpriseEdition);
  const normalizedTab = requestedTab?.toLowerCase();

  if (normalizedTab && visibleTabs.includes(normalizedTab)) {
    return normalizedTab;
  }

  return visibleTabs[0] ?? 'profile';
}