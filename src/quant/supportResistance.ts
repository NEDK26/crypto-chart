import type { Candle, LevelType, PriceLevel } from '../types/market';

interface SupportResistanceOptions {
  pivotWindow?: number;
  clusterTolerance?: number;
  maxLevelsPerType?: number;
}

interface CandidateLevel {
  type: LevelType;
  price: number;
  timestamp: number;
}

interface Cluster {
  type: LevelType;
  averagePrice: number;
  touches: number;
  latestTimestamp: number;
}

const DEFAULT_PIVOT_WINDOW = 3;
const DEFAULT_CLUSTER_TOLERANCE = 0.0035;
const DEFAULT_MAX_LEVELS_PER_TYPE = 4;

function isPivotHigh(candles: Candle[], index: number, window: number): boolean {
  const center = candles[index].high;

  for (let offset = 1; offset <= window; offset += 1) {
    if (candles[index - offset].high >= center || candles[index + offset].high > center) {
      return false;
    }
  }

  return true;
}

function isPivotLow(candles: Candle[], index: number, window: number): boolean {
  const center = candles[index].low;

  for (let offset = 1; offset <= window; offset += 1) {
    if (candles[index - offset].low <= center || candles[index + offset].low < center) {
      return false;
    }
  }

  return true;
}

function buildCandidates(candles: Candle[], window: number): CandidateLevel[] {
  const candidates: CandidateLevel[] = [];

  for (let index = window; index < candles.length - window; index += 1) {
    const candle = candles[index];

    if (isPivotHigh(candles, index, window)) {
      candidates.push({
        type: 'resistance',
        price: candle.high,
        timestamp: candle.timestamp,
      });
    }

    if (isPivotLow(candles, index, window)) {
      candidates.push({
        type: 'support',
        price: candle.low,
        timestamp: candle.timestamp,
      });
    }
  }

  return candidates;
}

function clusterCandidates(candidates: CandidateLevel[], tolerance: number): Cluster[] {
  const clusters: Cluster[] = [];

  for (const candidate of candidates) {
    const match = clusters.find(
      (cluster) =>
        cluster.type === candidate.type &&
        Math.abs(candidate.price - cluster.averagePrice) / cluster.averagePrice <= tolerance
    );

    if (match) {
      const nextTouches = match.touches + 1;
      match.averagePrice = (match.averagePrice * match.touches + candidate.price) / nextTouches;
      match.touches = nextTouches;
      match.latestTimestamp = Math.max(match.latestTimestamp, candidate.timestamp);
      continue;
    }

    clusters.push({
      type: candidate.type,
      averagePrice: candidate.price,
      touches: 1,
      latestTimestamp: candidate.timestamp,
    });
  }

  return clusters;
}

function scoreCluster(cluster: Cluster, latestTimestamp: number): number {
  const recency = Math.max(latestTimestamp - cluster.latestTimestamp, 1);
  const recencyWeight = 1 / Math.sqrt(recency / 60000);
  return cluster.touches * 0.75 + recencyWeight;
}

export function calculateSupportResistance(
  candles: Candle[],
  options: SupportResistanceOptions = {}
): PriceLevel[] {
  const pivotWindow = options.pivotWindow ?? DEFAULT_PIVOT_WINDOW;
  const clusterTolerance = options.clusterTolerance ?? DEFAULT_CLUSTER_TOLERANCE;
  const maxLevelsPerType = options.maxLevelsPerType ?? DEFAULT_MAX_LEVELS_PER_TYPE;

  if (candles.length < pivotWindow * 3) {
    return [];
  }

  const candidates = buildCandidates(candles, pivotWindow);
  const clusters = clusterCandidates(candidates, clusterTolerance);
  const latestTimestamp = candles[candles.length - 1].timestamp;

  const ranked = clusters
    .map((cluster) => ({
      cluster,
      strength: scoreCluster(cluster, latestTimestamp),
    }))
    .sort((left, right) => right.strength - left.strength);

  const supportLevels = ranked
    .filter((item) => item.cluster.type === 'support')
    .slice(0, maxLevelsPerType)
    .map((item, index) => ({
      id: `support-${index + 1}-${Math.round(item.cluster.averagePrice * 100)}`,
      type: 'support' as const,
      price: item.cluster.averagePrice,
      touches: item.cluster.touches,
      strength: item.strength,
      lastTouchedAt: item.cluster.latestTimestamp,
    }));

  const resistanceLevels = ranked
    .filter((item) => item.cluster.type === 'resistance')
    .slice(0, maxLevelsPerType)
    .map((item, index) => ({
      id: `resistance-${index + 1}-${Math.round(item.cluster.averagePrice * 100)}`,
      type: 'resistance' as const,
      price: item.cluster.averagePrice,
      touches: item.cluster.touches,
      strength: item.strength,
      lastTouchedAt: item.cluster.latestTimestamp,
    }));

  return [...supportLevels, ...resistanceLevels].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'support' ? -1 : 1;
    }
    return right.strength - left.strength;
  });
}
