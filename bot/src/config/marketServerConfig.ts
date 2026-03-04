import { z } from 'zod';

const DEFAULT_BINANCE_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

const envSchema = z.object({
  MARKET_SERVER_HOST: z.string().default('0.0.0.0'),
  MARKET_SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(4180),
  MARKET_SERVER_BINANCE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
  MARKET_SERVER_BINANCE_BASE_URLS: z.string().optional(),
});

export interface MarketServerConfig {
  host: string;
  port: number;
  binanceTimeoutMs: number;
  binanceBaseUrls: string[];
}

let marketServerConfig: MarketServerConfig | null = null;

function parseBaseUrls(rawValue?: string): string[] {
  if (!rawValue) {
    return DEFAULT_BINANCE_BASE_URLS;
  }

  const unique = new Set<string>();
  for (const segment of rawValue.split(',')) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        unique.add(parsed.origin);
      }
    } catch {
      continue;
    }
  }

  if (unique.size === 0) {
    return DEFAULT_BINANCE_BASE_URLS;
  }

  return Array.from(unique);
}

export function loadMarketServerConfig(): MarketServerConfig {
  if (marketServerConfig) {
    return marketServerConfig;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid market server environment variables:\n${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`
    );
  }

  marketServerConfig = {
    host: parsed.data.MARKET_SERVER_HOST,
    port: parsed.data.MARKET_SERVER_PORT,
    binanceTimeoutMs: parsed.data.MARKET_SERVER_BINANCE_TIMEOUT_MS,
    binanceBaseUrls: parseBaseUrls(parsed.data.MARKET_SERVER_BINANCE_BASE_URLS),
  };

  return marketServerConfig;
}

export function getMarketServerConfig(): MarketServerConfig {
  if (!marketServerConfig) {
    return loadMarketServerConfig();
  }

  return marketServerConfig;
}
