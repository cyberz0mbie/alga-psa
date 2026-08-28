import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pax8ApiClient } from './pax8ApiClient';

describe('Pax8ApiClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses a valid access token', async () => {
    const request = vi.fn();
    vi.spyOn(axios, 'create').mockReturnValue({ request } as any);
    const tokenRequest = vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        access_token: 'token-1',
        expires_in: 3600,
      },
    } as any);

    const client = new Pax8ApiClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    await expect(client.getAccessToken()).resolves.toBe('token-1');
    await expect(client.getAccessToken()).resolves.toBe('token-1');

    expect(tokenRequest).toHaveBeenCalledTimes(1);
  });

  it('walks Pax8 zero-based pagination until the last page', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: {
          content: [{ id: 'company-1', name: 'Company One' }],
          page: {
            size: 200,
            totalElements: 2,
            totalPages: 2,
            number: 0,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          content: [{ id: 'company-2', name: 'Company Two' }],
          page: {
            size: 200,
            totalElements: 2,
            totalPages: 2,
            number: 1,
          },
        },
      });

    vi.spyOn(axios, 'create').mockReturnValue({ request } as any);
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        access_token: 'token-1',
        expires_in: 3600,
      },
    } as any);

    const client = new Pax8ApiClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });

    const companies = await client.listCompanies();

    expect(companies.map((company) => company.id)).toEqual(['company-1', 'company-2']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: '/companies',
      params: { page: 0, size: 200 },
      headers: { Authorization: 'Bearer token-1' },
    });
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'GET',
      url: '/companies',
      params: { page: 1, size: 200 },
      headers: { Authorization: 'Bearer token-1' },
    });
  });
});
