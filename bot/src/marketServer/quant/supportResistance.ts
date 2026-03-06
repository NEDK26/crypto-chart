import type { Candle, LevelTier, LevelType, PriceLevel } from '../types.js';

interface SupportResistanceOptions {
  pivotWindow?: number;
  clusterTolerance?: number;
  maxLevelsPerType?: number;
  proximityThresholdRatio?: number;
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
  earliestTimestamp: number;
  earliestIndex: number;
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
const DEFAULT_MAX_LEVELS_PER_TYPE = 3;
const MIN_SAMPLE_CANDLES = 30;
const ATR_PERIOD = 14;
const MIN_ZONE_RATIO = 0.0006;
const MAX_ZONE_RATIO = 0.004;
const ZONE_ATR_MULTIPLIER = 0.18;
const ZONE_TOLERANCE_MULTIPLIER = 0.5;
const DEFAULT_NEAR_THRESHOLD_RATIO = 0.0025;

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(value, maxValue));
}

function calculateAtr(candles: Candle[], period: number): number {
  if (candles.length < 2) {
    const lastCandle = candles[candles.length - 1];
    return lastCandle ? Math.max(lastCandle.high - lastCandle.low, 0) : 0;
  }

  const startIndex = Math.max(1, candles.length - period);
  let trSum = 0;
  let count = 0;

  for (let index = startIndex; index < candles.length; index += 1) {
    const current = candles[index];
    const previousClose = candles[index - 1].close;

    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose)
    );

    trSum += trueRange;
    count += 1;
  }

  if (count === 0) {
    const lastCandle = candles[candles.length - 1];
    return lastCandle ? Math.max(lastCandle.high - lastCandle.low, 0) : 0;
  }

  return trSum / count;
}

function resolveTier(strengthRank: number): LevelTier {
  if (strengthRank <= 1) {
    return 'strong';
  }

  if (strengthRank === 2) {
    return 'mid';
  }

  return 'weak';
}

function mapRankedLevels(params: {
  ranked: RankedCluster[];
  side: LevelType;
  maxLevelsPerType: number;
  referencePrice: number;
  zoneHalf: number;
  nearThresholdRatio: number;
}): PriceLevel[] {
  const selectedByStrength = params.ranked
    .filter((item) => item.side === params.side)
    .slice(0, params.maxLevelsPerType)
    .map((item, index) => ({
      item,
      strengthRank: index + 1,
    }));

  selectedByStrength.sort((left, right) => {
    if (params.side === 'support') {
      return right.item.cluster.averagePrice - left.item.cluster.averagePrice;
    }

    return left.item.cluster.averagePrice - right.item.cluster.averagePrice;
  });

  return selectedByStrength.map(({ item, strengthRank }, index) => {
    const price = item.cluster.averagePrice;
    const zoneLow = Math.max(0, price - params.zoneHalf);
    const zoneHigh = price + params.zoneHalf;
    const distanceRatio = (price - params.referencePrice) / params.referencePrice;
    const distancePct = distanceRatio * 100;

    return {
      id: `${params.side}-${index + 1}-${Math.round(price * 100)}`,
      type: params.side,
      price,
      sourceTimestamp: item.cluster.earliestTimestamp,
      zoneLow,
      zoneHigh,
      rank: index + 1,
      tier: resolveTier(strengthRank),
      distancePct,
      isNear: Math.abs(distanceRatio) <= params.nearThresholdRatio,
      touches: item.cluster.touches,
      strength: item.strength,
      lastTouchedAt: item.cluster.latestTimestamp,
    };
  });
}

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
      match.earliestTimestamp = Math.min(match.earliestTimestamp, candidate.timestamp);
      match.earliestIndex = Math.min(match.earliestIndex, candidate.index);
      match.latestTimestamp = Math.max(match.latestTimestamp, candidate.timestamp);
      match.latestIndex = Math.max(match.latestIndex, candidate.index);
      continue;
    }

    clusters.push({
      type: candidate.type,
      averagePrice: candidate.price,
      touches: 1,
      earliestTimestamp: candidate.timestamp,
      earliestIndex: candidate.index,
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
  const nearThresholdRatio = Math.max(
    DEFAULT_NEAR_THRESHOLD_RATIO,
    (options.proximityThresholdRatio ?? DEFAULT_NEAR_THRESHOLD_RATIO) * 1.5
  );
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

  const atr = calculateAtr(candles, ATR_PERIOD);
  const zoneHalf = clamp(
    Math.max(
      atr * ZONE_ATR_MULTIPLIER,
      referencePrice * clusterTolerance * ZONE_TOLERANCE_MULTIPLIER
    ),
    referencePrice * MIN_ZONE_RATIO,
    referencePrice * MAX_ZONE_RATIO
  );

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

  const supportLevels = mapRankedLevels({
    ranked,
    side: 'support',
    maxLevelsPerType,
    referencePrice,
    zoneHalf,
    nearThresholdRatio,
  });

  const resistanceLevels = mapRankedLevels({
    ranked,
    side: 'resistance',
    maxLevelsPerType,
    referencePrice,
    zoneHalf,
    nearThresholdRatio,
  });

  return [...supportLevels, ...resistanceLevels];
}
