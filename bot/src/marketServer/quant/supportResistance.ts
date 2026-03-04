import type { Candle, LevelType, PriceLevel } from '../types.js';

interface SupportResistanceOptions {
  pivotWindow?: number;
  clusterTolerance?: number;
  maxLevelsPerType?: number;
}

interface CandidateLevel {
  type: LevelType;
  price: number;
  timestamp: number;
  index: number;
}

interface Cluster {
  type: LevelType;
  averagePrice: number;
  touches: number;
  latestTimestamp: number;
  latestIndex: number;
}

interface RankedCluster {
  cluster: Cluster;
  strength: number;
  side: LevelType;
}

const DEFAULT_PIVOT_WINDOW = 3;
const DEFAULT_CLUSTER_TOLERANCE = 0.0035;
const DEFAULT_MAX_LEVELS_PER_TYPE = 4;
const MIN_SAMPLE_CANDLES = 30;

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
        index,
      });
    }

    if (isPivotLow(candles, index, window)) {
      candidates.push({
        type: 'support',
        price: candle.low,
        timestamp: candle.timestamp,
        index,
      });
    }
  }

  return candidates;
}

function clusterCandidates(candidates: CandidateLevel[], tolerance: number): Cluster[] {
  const clusters: Cluster[] = [];

  for (const candidate of candidates) {
    let match: Cluster | null = null;
    let smallestDistanceRatio = Number.POSITIVE_INFINITY;

    for (const cluster of clusters) {
      if (cluster.type !== candidate.type) {
        continue;
      }

      const distanceRatio = Math.abs(candidate.price - cluster.averagePrice) / cluster.averagePrice;
      if (distanceRatio <= tolerance && distanceRatio < smallestDistanceRatio) {
        smallestDistanceRatio = distanceRatio;
        match = cluster;
      }
    }

    if (match) {
      const nextTouches = match.touches + 1;
      match.averagePrice = (match.averagePrice * match.touches + candidate.price) / nextTouches;
      match.touches = nextTouches;
      match.latestTimestamp = Math.max(match.latestTimestamp, candidate.timestamp);
      match.latestIndex = Math.max(match.latestIndex, candidate.index);
      continue;
    }

    clusters.push({
      type: candidate.type,
      averagePrice: candidate.price,
      touches: 1,
      latestTimestamp: candidate.timestamp,
      latestIndex: candidate.index,
    });
  }

  return clusters;
}

function scoreCluster(cluster: Cluster, latestIndex: number, referencePrice: number): number {
  const barsSinceTouch = Math.max(latestIndex - cluster.latestIndex, 0);
  const recencyWeight = 1 / Math.sqrt(barsSinceTouch + 1);
  const distanceRatio = Math.abs(cluster.averagePrice - referencePrice) / referencePrice;
  const proximityWeight = 1 / (1 + distanceRatio * 40);
  const touchWeight = Math.sqrt(cluster.touches);

  return touchWeight * 1.35 + recencyWeight * 1.1 + proximityWeight * 1.55;
}

export function calculateSupportResistance(
  candles: Candle[],
  options: SupportResistanceOptions = {}
): PriceLevel[] {
  const pivotWindow = options.pivotWindow ?? DEFAULT_PIVOT_WINDOW;
  const clusterTolerance = options.clusterTolerance ?? DEFAULT_CLUSTER_TOLERANCE;
  const maxLevelsPerType = options.maxLevelsPerType ?? DEFAULT_MAX_LEVELS_PER_TYPE;
  const minimumCandles = Math.max(pivotWindow * 4 + 1, MIN_SAMPLE_CANDLES);

  if (candles.length < minimumCandles) {
    return [];
  }

  const candidates = buildCandidates(candles, pivotWindow);
  const clusters = clusterCandidates(candidates, clusterTolerance);
  const latestIndex = candles.length - 1;
  const referencePrice = candles[latestIndex].close;

  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return [];
  }

  const ranked: RankedCluster[] = clusters
    .map((cluster) => {
      const side: LevelType = cluster.averagePrice <= referencePrice ? 'support' : 'resistance';

      return {
        cluster,
        strength: scoreCluster(cluster, latestIndex, referencePrice),
        side,
      };
    })
    .sort((left, right) => right.strength - left.strength);

  const supportLevels = ranked
    .filter((item) => item.side === 'support')
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
    .filter((item) => item.side === 'resistance')
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
