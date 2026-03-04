import type { KlineInterval } from './types.js';

export interface IntervalSettings {
  historyLimit: number;
  pivotWindow: number;
  clusterTolerance: number;
  maxLevelsPerType: number;
  proximityThresholdRatio: number;
}

export const INTERVAL_SETTINGS: Record<KlineInterval, IntervalSettings> = {
  '1m': {
    historyLimit: 1000,
    pivotWindow: 5,
    clusterTolerance: 0.0016,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0009,
  },
  '5m': {
    historyLimit: 1000,
    pivotWindow: 3,
    clusterTolerance: 0.0028,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0011,
  },
  '1h': {
    historyLimit: 800,
    pivotWindow: 3,
    clusterTolerance: 0.003,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0016,
  },
  '4h': {
    historyLimit: 700,
    pivotWindow: 3,
    clusterTolerance: 0.0042,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0022,
  },
  '1d': {
    historyLimit: 500,
    pivotWindow: 2,
    clusterTolerance: 0.006,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0032,
  },
};

export const SUPPORTED_INTERVALS: KlineInterval[] = Object.keys(
  INTERVAL_SETTINGS
) as KlineInterval[];

export function isSupportedInterval(value: string): value is KlineInterval {
  return SUPPORTED_INTERVALS.includes(value as KlineInterval);
}

export function getChannelKey(symbol: string, interval: KlineInterval): string {
  return `${symbol.toUpperCase()}:${interval}`;
}

export function splitChannelKey(channelKey: string): [string, KlineInterval] | null {
  const parts = channelKey.split(':');
  if (parts.length !== 2) {
    return null;
  }

  const symbol = parts[0]?.toUpperCase();
  const interval = parts[1];
  if (!symbol || !interval || !isSupportedInterval(interval)) {
    return null;
  }

  return [symbol, interval];
}
