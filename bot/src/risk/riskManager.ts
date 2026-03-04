import { getConfig } from '../config/index.js';
import { logger } from '../monitor/logger.js';
import { TradeSignal } from '../data/types.js';

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

export class RiskManager {
  private dailyLoss = 0;
  private tradeCount = 0;
  private lastResetDate: string;

  constructor() {
    this.lastResetDate = new Date().toDateString();
  }

  checkBeforeTrade(signal: TradeSignal, currentPosition: boolean): RiskCheckResult {
    this.checkDailyReset();
    const config = getConfig();

    if (Math.abs(this.dailyLoss) >= config.MAX_DAILY_LOSS) {
      logger.warn('Daily loss limit reached, stopping trading');
      return {
        allowed: false,
        reason: 'Daily loss limit reached',
      };
    }

    if (signal.action === 'BUY' && currentPosition) {
      return {
        allowed: false,
        reason: 'Position already exists',
      };
    }

    if (signal.action === 'SELL' && !currentPosition) {
      return {
        allowed: false,
        reason: 'No position to close',
      };
    }

    return { allowed: true };
  }

  calculatePositionSize(balance: number): number {
    const config = getConfig();
    return Math.min(balance * 0.1, config.MAX_POSITION_SIZE);
  }

  recordTrade(pnl: number): void {
    this.dailyLoss += pnl;
    this.tradeCount++;
    logger.info({ dailyLoss: this.dailyLoss, tradeCount: this.tradeCount }, 'Trade recorded');
  }

  private checkDailyReset(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLoss = 0;
      this.tradeCount = 0;
      this.lastResetDate = today;
      logger.info('Daily risk metrics reset');
    }
  }

  getStatus(): { dailyLoss: number; tradeCount: number } {
    return {
      dailyLoss: this.dailyLoss,
      tradeCount: this.tradeCount,
    };
  }
}
