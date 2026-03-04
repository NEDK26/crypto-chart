import type { BollingerBandPoint, Candle } from '../types.js';

interface BollingerOptions {
  period?: number;
  stdDevMultiplier?: number;
}

const DEFAULT_PERIOD = 20;
const DEFAULT_STD_DEV_MULTIPLIER = 2;

function calculateMean(values: number[]): number {
  const sum = values.reduce((accumulator, value) => accumulator + value, 0);
  return sum / values.length;
}

function calculateStandardDeviation(values: number[], mean: number): number {
  const variance =
    values.reduce((accumulator, value) => {
      const delta = value - mean;
      return accumulator + delta * delta;
    }, 0) / values.length;

  return Math.sqrt(variance);
}

export function calculateBollingerBands(
  candles: Candle[],
  options: BollingerOptions = {}
): BollingerBandPoint[] {
  const period = options.period ?? DEFAULT_PERIOD;
  const stdDevMultiplier = options.stdDevMultiplier ?? DEFAULT_STD_DEV_MULTIPLIER;

  if (candles.length < period) {
    return [];
  }

  const result: BollingerBandPoint[] = [];

  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1);
    const closes = window.map((candle) => candle.close);
    const middle = calculateMean(closes);
    const standardDeviation = calculateStandardDeviation(closes, middle);

    result.push({
      timestamp: candles[index].timestamp,
      middle,
      upper: middle + standardDeviation * stdDevMultiplier,
      lower: middle - standardDeviation * stdDevMultiplier,
    });
  }

  return result;
}
