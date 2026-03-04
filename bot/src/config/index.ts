import { z } from 'zod';

const envSchema = z.object({
  BINANCE_API_KEY: z.string().min(1),
  BINANCE_SECRET_KEY: z.string().min(1),
  TRADING_PAIR: z.string().default('BTCUSDT'),
  TRADING_INTERVAL: z.string().default('1m'),
  MAX_POSITION_SIZE: z.coerce.number().default(0.1),
  MAX_DAILY_LOSS: z.coerce.number().default(0.02),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof envSchema>;

let config: Config | null = null;

export function loadConfig(): Config {
  if (config) return config;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n')}`
    );
  }

  config = result.data;
  return config;
}

export function getConfig(): Config {
  if (!config) {
    return loadConfig();
  }
  return config;
}
