import axios, { AxiosError, AxiosInstance } from 'axios';

const PAX8_API_BASE_URL = 'https://api.pax8.com/v1';
const PAX8_TOKEN_URL = 'https://api.pax8.com/v1/token';
const PAX8_AUDIENCE = 'https://api.pax8.com';
const MAX_PAGE_SIZE = 200;

export interface Pax8PageMetadata {
  size: number;
  totalElements: number;
  totalPages: number;
  number: number;
}

export interface Pax8Page<T> {
  content: T[];
  page: Pax8PageMetadata;
}

export interface Pax8TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

export interface Pax8Company {
  id: string;
  name: string;
  status?: string;
  externalId?: string | null;
  website?: string | null;
  phone?: string | null;
  [key: string]: unknown;
}

export interface Pax8Product {
  id: string;
  name: string;
  sku?: string | null;
  vendor?: string | null;
  vendorName?: string | null;
  [key: string]: unknown;
}

export interface Pax8Subscription {
  id: string;
  companyId: string;
  productId: string;
  quantity?: number | null;
  status?: string | null;
  billingTerm?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  commitmentTermEndDate?: string | null;
  price?: number | null;
  vendorSkuId?: string | null;
  [key: string]: unknown;
}

export interface Pax8ProductPricing {
  [key: string]: unknown;
}

export interface Pax8ClientOptions {
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

function retryDelayMs(error: AxiosError, attempt: number): number {
  const retryAfter = error.response?.headers?.['retry-after'];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
  }

  return Math.min(500 * 2 ** attempt, 5_000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class Pax8ApiClient {
  private readonly http: AxiosInstance;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(private readonly options: Pax8ClientOptions) {
    if (!options.clientId?.trim()) throw new Error('Pax8 client ID is required');
    if (!options.clientSecret?.trim()) throw new Error('Pax8 client secret is required');

    this.http = axios.create({
      baseURL: PAX8_API_BASE_URL,
      timeout: options.timeoutMs ?? 30_000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  private tokenIsUsable(): boolean {
    // Refresh at least 60 seconds before expiration.
    return Boolean(this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000);
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.tokenIsUsable()) {
      return this.accessToken!;
    }

    const response = await axios.post<Pax8TokenResponse>(
      PAX8_TOKEN_URL,
      {
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        audience: PAX8_AUDIENCE,
        grant_type: 'client_credentials',
      },
      {
        timeout: this.options.timeoutMs ?? 30_000,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response.data?.access_token) {
      throw new Error('Pax8 authentication succeeded but no access token was returned');
    }

    this.accessToken = response.data.access_token;
    const expiresInSeconds = Number(response.data.expires_in ?? 86_400);
    this.accessTokenExpiresAt = Date.now() + Math.max(expiresInSeconds, 60) * 1000;
    return this.accessToken;
  }

  private async request<T>(args: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    params?: Record<string, string | number | boolean | undefined>;
    data?: unknown;
    attempt?: number;
    didRefresh?: boolean;
  }): Promise<T> {
    const token = await this.getAccessToken();
    const attempt = args.attempt ?? 0;

    try {
      const response = await this.http.request<T>({
        method: args.method ?? 'GET',
        url: args.path,
        params: args.params,
        data: args.data,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;

      // Access tokens are long-lived, but retry once with a fresh token if the
      // API rejects a cached token.
      if (status === 401 && !args.didRefresh) {
        await this.getAccessToken(true);
        return this.request<T>({ ...args, didRefresh: true });
      }

      if (attempt < 2 && isRetryableStatus(status)) {
        await sleep(retryDelayMs(axiosError, attempt));
        return this.request<T>({ ...args, attempt: attempt + 1 });
      }

      throw error;
    }
  }

  private async listAll<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T[]> {
    const size = Math.min(Number(params.size ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE);
    const results: T[] = [];
    let pageNumber = 0;

    while (true) {
      const response = await this.request<Pax8Page<T>>({
        path,
        params: {
          ...params,
          page: pageNumber,
          size,
        },
      });

      results.push(...(response.content ?? []));

      const totalPages = Number(response.page?.totalPages ?? 0);
      const currentPage = Number(response.page?.number ?? pageNumber);
      if (totalPages === 0 || currentPage >= totalPages - 1) break;
      pageNumber = currentPage + 1;
    }

    return results;
  }

  async testConnection(): Promise<boolean> {
    await this.getAccessToken();
    await this.request<Pax8Page<Pax8Company>>({
      path: '/companies',
      params: { page: 0, size: 1 },
    });
    return true;
  }

  async listCompanies(): Promise<Pax8Company[]> {
    return this.listAll<Pax8Company>('/companies');
  }

  async getCompany(companyId: string): Promise<Pax8Company> {
    return this.request<Pax8Company>({ path: `/companies/${encodeURIComponent(companyId)}` });
  }

  async listSubscriptions(params: {
    status?: string;
    billingTerm?: string;
    companyId?: string;
    productId?: string;
  } = {}): Promise<Pax8Subscription[]> {
    return this.listAll<Pax8Subscription>('/subscriptions', params);
  }

  async getSubscription(subscriptionId: string): Promise<Pax8Subscription> {
    return this.request<Pax8Subscription>({
      path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    });
  }

  async listProducts(params: { search?: string; vendorName?: string } = {}): Promise<Pax8Product[]> {
    return this.listAll<Pax8Product>('/products', params);
  }

  async getProduct(productId: string): Promise<Pax8Product> {
    return this.request<Pax8Product>({ path: `/products/${encodeURIComponent(productId)}` });
  }

  async getProductPricing(productId: string, companyId?: string): Promise<Pax8ProductPricing> {
    return this.request<Pax8ProductPricing>({
      path: `/products/${encodeURIComponent(productId)}/pricing`,
      params: companyId ? { companyId } : undefined,
    });
  }
}
