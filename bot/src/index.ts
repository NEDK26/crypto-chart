import { loadConfig, getConfig } from './config/index.js';
import { binanceApi } from './data/binanceApi.js';
import { BinanceWsClient } from './data/binanceWs.js';
import { EmaCrossoverStrategy } from './strategy/emaCrossover.js';
import { OrderExecutor } from './execution/orderExecutor.js';
import { RiskManager } from './risk/riskManager.js';
import { logger } from './monitor/logger.js';
import { Kline } from './data/types.js';

class TradingBot {
  private wsClient: BinanceWsClient;
  private strategy: EmaCrossoverStrategy;
  private executor: OrderExecutor;
  private riskManager: RiskManager;
  private isRunning = false;

  constructor() {
    this.wsClient = new BinanceWsClient();
    this.strategy = new EmaCrossoverStrategy();
    this.executor = new OrderExecutor();
    this.riskManager = new RiskManager();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Bot is already running');
      return;
    }

    loadConfig();
    const config = getConfig();

    logger.info({ config: { ...config, BINANCE_SECRET_KEY: '***' } }, 'Starting trading bot');

    await this.initializeHistoricalData(config.TRADING_PAIR, config.TRADING_INTERVAL);

    this.wsClient.onKline((kline) => this.handleKline(kline));
    this.wsClient.connect([`${config.TRADING_PAIR.toLowerCase()}@kline_${config.TRADING_INTERVAL}`]);

    this.isRunning = true;
    logger.info('Trading bot started successfully');
  }

  private async initializeHistoricalData(symbol: string, interval: string): Promise<void> {
    try {
      const klines = await binanceApi.getKlines(symbol, interval, 500);
      klines.forEach((kline) => this.strategy.addKline(kline));
      logger.info({ count: klines.length }, 'Historical data loaded');
    } catch (error) {
      logger.error({ error }, 'Failed to load historical data');
      throw error;
    }
  }

  private async handleKline(kline: Kline): Promise<void> {
    this.strategy.addKline(kline);
    const signal = this.strategy.analyze();

    if (signal.action === 'HOLD') {
      return;
    }

    const riskCheck = this.riskManager.checkBeforeTrade(signal, this.executor.hasPosition());

    if (!riskCheck.allowed) {
      logger.info({ signal, reason: riskCheck.reason }, 'Trade blocked by risk manager');
      return;
    }

    try {
      if (signal.action === 'BUY') {
        const balance = await binanceApi.getAccountBalance();
        const usdt = balance.find((b) => b.asset === 'USDT');
        const quantity = this.riskManager.calculatePositionSize(usdt?.free ?? 0);

        if (quantity > 0) {
          await this.executor.executeBuy(quantity, signal.price);
          this.riskManager.recordTrade(0);
        }
      } else if (signal.action === 'SELL') {
        const position = this.executor.getPosition();
        if (position) {
          await this.executor.executeSell(position.quantity, signal.price);
          const pnl = (signal.price - position.entryPrice) * position.quantity;
          this.riskManager.recordTrade(pnl);
        }
      }
    } catch (error) {
      logger.error({ error, signal }, 'Failed to execute trade');
    }
  }

  stop(): void {
    this.wsClient.close();
    this.isRunning = false;
    logger.info('Trading bot stopped');
  }
}

const bot = new TradingBot();

bot.start().catch((error) => {
  logger.error({ error }, 'Fatal error');
  process.exit(1);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  bot.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  bot.stop();
  process.exit(0);
});
