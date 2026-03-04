import { binanceApi } from '../data/binanceApi.js';
import { Order, Position } from '../data/types.js';
import { logger } from '../monitor/logger.js';
import { getConfig } from '../config/index.js';

export class OrderExecutor {
  private position: Position | null = null;

  async executeBuy(quantity: number, price: number): Promise<Order> {
    const config = getConfig();

    const order: Order = {
      symbol: config.TRADING_PAIR,
      side: 'BUY',
      type: 'MARKET',
      quantity,
    };

    logger.info({ order }, 'Executing BUY order');

    try {
      const result = await binanceApi.placeOrder(order);
      this.position = {
        symbol: config.TRADING_PAIR,
        quantity,
        entryPrice: price,
        unrealizedPnl: 0,
      };
      logger.info({ order: result }, 'BUY order filled');
      return result;
    } catch (error) {
      logger.error({ error, order }, 'Failed to execute BUY order');
      throw error;
    }
  }

  async executeSell(quantity: number, price: number): Promise<Order> {
    const config = getConfig();

    const order: Order = {
      symbol: config.TRADING_PAIR,
      side: 'SELL',
      type: 'MARKET',
      quantity,
    };

    logger.info({ order }, 'Executing SELL order');

    try {
      const result = await binanceApi.placeOrder(order);
      this.position = null;
      logger.info({ order: result }, 'SELL order filled');
      return result;
    } catch (error) {
      logger.error({ error, order }, 'Failed to execute SELL order');
      throw error;
    }
  }

  getPosition(): Position | null {
    return this.position;
  }

  hasPosition(): boolean {
    return this.position !== null && this.position.quantity > 0;
  }
}
