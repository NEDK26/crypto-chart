import {
  EMA,
  RSI,
  MACD,
  BollingerBands,
} from 'technicalindicators';
import { Kline, TradeSignal } from '../data/types.js';
import { logger } from '../monitor/logger.js';

export interface StrategyParams {
  emaShortPeriod: number;
  emaLongPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
}

const defaultParams: StrategyParams = {
  emaShortPeriod: 12,
  emaLongPeriod: 26,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
};

export class EmaCrossoverStrategy {
  private params: StrategyParams;
  private klines: Kline[] = [];
  private lastSignal: TradeSignal | null = null;

  constructor(params: Partial<StrategyParams> = {}) {
    this.params = { ...defaultParams, ...params };
  }

  addKline(kline: Kline): void {
    this.klines.push(kline);
    if (this.klines.length > 500) {
      this.klines.shift();
    }
  }

  analyze(): TradeSignal {
    if (this.klines.length < this.params.emaLongPeriod + 10) {
      return {
        strategy: 'EMA_CROSSOVER',
        action: 'HOLD',
        price: this.klines[this.klines.length - 1]?.close ?? 0,
        timestamp: Date.now(),
        reason: 'Insufficient data',
      };
    }

    const closes = this.klines.map((k) => k.close);

    const emaShort = EMA.calculate({
      values: closes,
      period: this.params.emaShortPeriod,
    });

    const emaLong = EMA.calculate({
      values: closes,
      period: this.params.emaLongPeriod,
    });

    const rsi = RSI.calculate({
      values: closes,
      period: this.params.rsiPeriod,
    });

    const currentShort = emaShort[emaShort.length - 1];
    const currentLong = emaLong[emaLong.length - 1];
    const prevShort = emaShort[emaShort.length - 2];
    const prevLong = emaLong[emaLong.length - 2];
    const currentRsi = rsi[rsi.length - 1];
    const currentPrice = closes[closes.length - 1];

    if (!currentShort || !currentLong || !prevShort || !prevLong) {
      return this.lastSignal!;
    }

    const signal = this.generateSignal(
      currentShort,
      currentLong,
      prevShort,
      prevLong,
      currentRsi,
      currentPrice
    );

    this.lastSignal = signal;
    return signal;
  }

  private generateSignal(
    short: number,
    long: number,
    prevShort: number,
    prevLong: number,
    rsi: number,
    price: number
  ): TradeSignal {
    const goldenCross = prevShort <= prevLong && short > long;
    const deathCross = prevShort >= prevLong && short < long;

    if (goldenCross && rsi < this.params.rsiOverbought) {
      logger.info({ short, long, rsi, price }, 'BUY signal - Golden cross');
      return {
        strategy: 'EMA_CROSSOVER',
        action: 'BUY',
        price,
        timestamp: Date.now(),
        reason: `Golden cross (EMA${this.params.emaShortPeriod} crosses above EMA${this.params.emaLongPeriod}), RSI: ${rsi.toFixed(2)}`,
      };
    }

    if (deathCross && rsi > this.params.rsiOversold) {
      logger.info({ short, long, rsi, price }, 'SELL signal - Death cross');
      return {
        strategy: 'EMA_CROSSOVER',
        action: 'SELL',
        price,
        timestamp: Date.now(),
        reason: `Death cross (EMA${this.params.emaShortPeriod} crosses below EMA${this.params.emaLongPeriod}), RSI: ${rsi.toFixed(2)}`,
      };
    }

    return {
      strategy: 'EMA_CROSSOVER',
      action: 'HOLD',
      price,
      timestamp: Date.now(),
      reason: 'No clear signal',
    };
  }

  reset(): void {
    this.klines = [];
    this.lastSignal = null;
  }
}
