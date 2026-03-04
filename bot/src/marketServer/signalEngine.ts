import type {
  BollingerBandPoint,
  Candle,
  PriceLevel,
  SignalEvent,
  SignalType,
} from './types.js';

const SIGNAL_DESCRIPTIONS: Record<SignalType, string> = {
  breakout_up: '价格向上突破布林上轨',
  breakout_down: '价格向下跌破布林下轨',
  support_touch: '价格接近支撑位，留意止跌确认',
  resistance_touch: '价格接近阻力位，留意量能突破',
};

export interface SignalEvaluationInput {
  candles: Candle[];
  latestBand: BollingerBandPoint | null;
  supportResistanceLevels: PriceLevel[];
  previousSignals: SignalEvent[];
  previousFingerprint: string | null;
  proximityThresholdRatio: number;
  signalLimit: number;
}

export interface SignalEvaluationResult {
  signals: SignalEvent[];
  fingerprint: string | null;
}

function buildSignalEvent(type: SignalType, price: number, timestamp: number): SignalEvent {
  return {
    id: `${type}-${timestamp}-${Math.round(price * 100)}`,
    type,
    price,
    timestamp,
    description: SIGNAL_DESCRIPTIONS[type],
  };
}

export function evaluateSignals(input: SignalEvaluationInput): SignalEvaluationResult {
  const lastCandle = input.candles[input.candles.length - 1];
  if (!lastCandle) {
    return {
      signals: input.previousSignals,
      fingerprint: input.previousFingerprint,
    };
  }

  const supportLevels = input.supportResistanceLevels.filter((level) => level.type === 'support');
  const resistanceLevels = input.supportResistanceLevels.filter((level) => level.type === 'resistance');
  const threshold = lastCandle.close * input.proximityThresholdRatio;

  const nearestSupport = supportLevels
    .filter((level) => level.price <= lastCandle.close)
    .sort((left, right) => right.price - left.price)[0];

  const nearestResistance = resistanceLevels
    .filter((level) => level.price >= lastCandle.close)
    .sort((left, right) => left.price - right.price)[0];

  let nextSignal: SignalEvent | null = null;

  if (input.latestBand && lastCandle.close > input.latestBand.upper) {
    nextSignal = buildSignalEvent('breakout_up', lastCandle.close, lastCandle.timestamp);
  } else if (input.latestBand && lastCandle.close < input.latestBand.lower) {
    nextSignal = buildSignalEvent('breakout_down', lastCandle.close, lastCandle.timestamp);
  } else if (nearestSupport && Math.abs(lastCandle.close - nearestSupport.price) <= threshold) {
    nextSignal = buildSignalEvent('support_touch', nearestSupport.price, lastCandle.timestamp);
  } else if (nearestResistance && Math.abs(lastCandle.close - nearestResistance.price) <= threshold) {
    nextSignal = buildSignalEvent('resistance_touch', nearestResistance.price, lastCandle.timestamp);
  }

  if (!nextSignal) {
    return {
      signals: input.previousSignals,
      fingerprint: input.previousFingerprint,
    };
  }

  const fingerprint = `${nextSignal.type}-${Math.round(nextSignal.price * 100)}-${Math.floor(
    nextSignal.timestamp / 60000
  )}`;

  if (input.previousFingerprint === fingerprint) {
    return {
      signals: input.previousSignals,
      fingerprint: input.previousFingerprint,
    };
  }

  return {
    signals: [nextSignal, ...input.previousSignals].slice(0, input.signalLimit),
    fingerprint,
  };
}
