import axios from 'axios';
import { FxRateService } from './fx-rate.service';

jest.mock('axios');
const mockedGet = axios.get as jest.Mock;

describe('FxRateService circuit breaker', () => {
  let service: FxRateService;
  let store: Map<string, unknown>;
  let now: number;

  const config: Record<string, unknown> = {
    FX_RATE_API_URL: 'https://fx.example.com/rate',
    FX_RATE_CACHE_TTL_SECONDS: 300,
    FX_BREAKER_FAILURE_THRESHOLD: 2,
    FX_BREAKER_COOLDOWN_SECONDS: 60,
  };

  beforeEach(() => {
    now = Date.parse('2026-10-20T00:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockedGet.mockReset();
    store = new Map();

    const redis = {
      getJson: jest.fn(async (key: string) => store.get(key) ?? null),
      setJson: jest.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    };
    const tokenRegistry = { listTokens: () => [{ symbol: 'USDC' }] };
    const configService = {
      get: jest.fn((key: string, def?: unknown) => (key in config ? config[key] : def)),
    };

    service = new FxRateService(configService as any, redis as any, tokenRegistry as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Simulates the fresh cache entry expiring (its Redis TTL elapsing). */
  const expireFreshCache = () => store.delete('fx:rate:USDC');

  it('stores fetched rates in the fresh cache and the last-known copy', async () => {
    mockedGet.mockResolvedValue({ data: { rate: 1.001 } });

    await service.refreshAllRates();

    expect(store.get('fx:rate:USDC')).toMatchObject({ rate: 1.001 });
    expect(store.get('fx:rate:USDC:last')).toMatchObject({ rate: 1.001 });
    expect(await service.getUsdRate('USDC')).toEqual({ rate: 1.001, asOf: expect.any(String) });
    expect(service.getBreakerState().state).toBe('CLOSED');
  });

  it('opens after repeated failures and stops calling the provider', async () => {
    mockedGet.mockRejectedValue(new Error('timeout of 5000ms exceeded'));

    await service.refreshAllRates();
    await service.refreshAllRates();
    expect(service.getBreakerState()).toMatchObject({
      state: 'OPEN',
      consecutiveFailures: 2,
      lastError: 'timeout of 5000ms exceeded',
    });

    mockedGet.mockClear();
    await service.refreshAllRates();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('serves the last cached rate marked stale while the breaker is open', async () => {
    mockedGet.mockResolvedValueOnce({ data: { rate: 0.99 } });
    await service.refreshAllRates();

    mockedGet.mockRejectedValue(new Error('provider down'));
    await service.refreshAllRates();
    await service.refreshAllRates();
    expect(service.getBreakerState().state).toBe('OPEN');

    // Still within the cache TTL — served, but flagged stale
    expect(await service.getUsdRate('USDC')).toMatchObject({ rate: 0.99, stale: true });

    // Fresh entry expired — falls back to the last-known copy
    expireFreshCache();
    expect(await service.getUsdRate('USDC')).toMatchObject({ rate: 0.99, stale: true });
    expect(await service.getRateEntry('USDC')).toMatchObject({ rate: 0.99, stale: true });
  });

  it('recovers automatically after the cool-down', async () => {
    mockedGet.mockRejectedValue(new Error('provider down'));
    await service.refreshAllRates();
    await service.refreshAllRates();
    expect(service.getBreakerState().state).toBe('OPEN');

    now += 60_000;
    expect(service.getBreakerState().state).toBe('HALF_OPEN');

    mockedGet.mockResolvedValue({ data: { rate: 1.002 } });
    await service.refreshAllRates();

    expect(service.getBreakerState().state).toBe('CLOSED');
    const rate = await service.getUsdRate('USDC');
    expect(rate).toEqual({ rate: 1.002, asOf: expect.any(String) });
  });

  it('counts invalid payloads as failures', async () => {
    mockedGet.mockResolvedValue({ data: { rate: 'not-a-number' } });

    await service.refreshAllRates();
    await service.refreshAllRates();

    expect(service.getBreakerState().state).toBe('OPEN');
  });
});
