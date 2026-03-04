import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { marketLogger } from './logger.js';
import {
  INTERVAL_SETTINGS,
  getChannelKey,
  type IntervalSettings,
} from './intervalConfig.js';
import { calculateBollingerBands } from './quant/bollinger.js';
import { calculateSupportResistance } from './quant/supportResistance.js';
import { evaluateSignals } from './signalEngine.js';
import type {
  BollingerBandPoint,
  Candle,
  KlineInterval,
  MarketDepthUpdatePayload,
  MarketKlineUpdatePayload,
  MarketSnapshot,
  OrderBookLevel,
  OrderBookSnapshot,
  PriceLevel,
  SignalEvent,
} from './types.js';

interface MarketChannelState {
  key: string;
  symbol: string;
  interval: KlineInterval;
  candles: Candle[];
  currentPrice: number | null;
  latestBand: BollingerBandPoint | null;
  supportResistanceLevels: PriceLevel[];
  signals: SignalEvent[];
  lastSignalFingerprint: string | null;
  refCount: number;
  initialization: Promise<void> | null;
}

interface SymbolDepthState {
  symbol: string;
  orderBook: OrderBookSnapshot;
  refCount: number;
}

export interface KlineUpdateEvent {
  symbol: string;
  interval: KlineInterval;
  payload: MarketKlineUpdatePayload;
}

export interface DepthUpdateEvent {
  symbol: string;
  payload: MarketDepthUpdatePayload;
}

export interface MarketDataServiceOptions {
  binanceBaseUrls: string[];
  restTimeoutMs: number;
}

const WS_BASE_URL = 'wss://data-stream.binance.vision/ws';
const ORDERBOOK_DEPTH = 12;
const SIGNAL_LIMIT = 16;

function toOrderBookLevels(levels: string[][]): OrderBookLevel[] {
  return levels.slice(0, ORDERBOOK_DEPTH).map((level) => {
    const price = Number.parseFloat(level[0] ?? '0');
    const quantity = Number.parseFloat(level[1] ?? '0');

    return {
      price,
      quantity,
      notional: price * quantity,
    };
  });
}

function upsertCandle(candles: Candle[], candle: Candle, historyLimit: number): Candle[] {
  if (candles.length === 0) {
    return [candle];
  }

  const lastCandle = candles[candles.length - 1];
  if (lastCandle.timestamp === candle.timestamp) {
    const next = [...candles];
    next[next.length - 1] = candle;
    return next;
  }

  const next = [...candles, candle];
  if (historyLimit > 0 && next.length > historyLimit) {
    return next.slice(next.length - historyLimit);
  }

  return next;
}

export class MarketDataService extends EventEmitter {
  private readonly channels = new Map<string, MarketChannelState>();
  private readonly symbolDepth = new Map<string, SymbolDepthState>();
  private readonly klineSockets = new Map<string, WebSocket>();
  private readonly depthSockets = new Map<string, WebSocket>();
  private readonly klineReconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly depthReconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly binanceBaseUrls: string[];
  private readonly restTimeoutMs: number;
  private preferredBaseUrl: string | null = null;

  constructor(options: MarketDataServiceOptions) {
    super();
    this.binanceBaseUrls = options.binanceBaseUrls;
    this.restTimeoutMs = options.restTimeoutMs;
  }

  async getSnapshot(symbol: string, interval: KlineInterval): Promise<MarketSnapshot> {
    const normalizedSymbol = symbol.toUpperCase();
    const channel = this.getOrCreateChannel(normalizedSymbol, interval);
    await this.ensureChannelInitialized(channel);
    return this.buildSnapshot(channel);
  }

  async subscribeChannel(symbol: string, interval: KlineInterval): Promise<MarketSnapshot> {
    const normalizedSymbol = symbol.toUpperCase();
    const channel = this.getOrCreateChannel(normalizedSymbol, interval);
    channel.refCount += 1;

    const depthState = this.getOrCreateDepthState(normalizedSymbol);
    depthState.refCount += 1;

    await this.ensureChannelInitialized(channel);
    this.ensureKlineSocket(channel);
    this.ensureDepthSocket(normalizedSymbol);

    return this.buildSnapshot(channel);
  }

  unsubscribeChannel(symbol: string, interval: KlineInterval): void {
    const normalizedSymbol = symbol.toUpperCase();
    const channelKey = getChannelKey(normalizedSymbol, interval);
    const channel = this.channels.get(channelKey);
    if (!channel) {
      return;
    }

    channel.refCount = Math.max(0, channel.refCount - 1);
    if (channel.refCount === 0) {
      this.closeKlineSocket(channel.key);
    }

    const depthState = this.symbolDepth.get(normalizedSymbol);
    if (!depthState) {
      return;
    }

    depthState.refCount = Math.max(0, depthState.refCount - 1);
    if (depthState.refCount === 0) {
      this.closeDepthSocket(normalizedSymbol);
    }
  }

  onKlineUpdate(listener: (event: KlineUpdateEvent) => void): void {
    this.on('kline_update', listener);
  }

  onDepthUpdate(listener: (event: DepthUpdateEvent) => void): void {
    this.on('depth_update', listener);
  }

  close(): void {
    for (const timer of this.klineReconnectTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.depthReconnectTimers.values()) {
      clearTimeout(timer);
    }

    this.klineReconnectTimers.clear();
    this.depthReconnectTimers.clear();

    for (const socket of this.klineSockets.values()) {
      socket.close();
    }
    for (const socket of this.depthSockets.values()) {
      socket.close();
    }

    this.klineSockets.clear();
    this.depthSockets.clear();
  }

  private getOrCreateChannel(symbol: string, interval: KlineInterval): MarketChannelState {
    const key = getChannelKey(symbol, interval);
    const existing = this.channels.get(key);
    if (existing) {
      return existing;
    }

    const created: MarketChannelState = {
      key,
      symbol,
      interval,
      candles: [],
      currentPrice: null,
      latestBand: null,
      supportResistanceLevels: [],
      signals: [],
      lastSignalFingerprint: null,
      refCount: 0,
      initialization: null,
    };
    this.channels.set(key, created);
    return created;
  }

  private getOrCreateDepthState(symbol: string): SymbolDepthState {
    const existing = this.symbolDepth.get(symbol);
    if (existing) {
      return existing;
    }

    const created: SymbolDepthState = {
      symbol,
      orderBook: {
        bids: [],
        asks: [],
      },
      refCount: 0,
    };

    this.symbolDepth.set(symbol, created);
    return created;
  }

  private async ensureChannelInitialized(channel: MarketChannelState): Promise<void> {
    if (channel.candles.length > 0) {
      return;
    }

    if (!channel.initialization) {
      channel.initialization = this.initializeChannel(channel).finally(() => {
        channel.initialization = null;
      });
    }

    await channel.initialization;
  }

  private async initializeChannel(channel: MarketChannelState): Promise<void> {
    const settings = INTERVAL_SETTINGS[channel.interval];
    const candles = await this.fetchHistoricalCandles(
      channel.symbol,
      channel.interval,
      settings.historyLimit
    );

    channel.candles = candles;
    channel.currentPrice = candles[candles.length - 1]?.close ?? null;
    this.recomputeDerivedState(channel, settings);
  }

  private recomputeDerivedState(channel: MarketChannelState, settings: IntervalSettings): void {
    const bollingerSeries = calculateBollingerBands(channel.candles, {
      period: 20,
      stdDevMultiplier: 2,
    });
    channel.latestBand =
      bollingerSeries.length > 0 ? bollingerSeries[bollingerSeries.length - 1] : null;

    channel.supportResistanceLevels = calculateSupportResistance(channel.candles, {
      pivotWindow: settings.pivotWindow,
      clusterTolerance: settings.clusterTolerance,
      maxLevelsPerType: settings.maxLevelsPerType,
    });

    const signalResult = evaluateSignals({
      candles: channel.candles,
      latestBand: channel.latestBand,
      supportResistanceLevels: channel.supportResistanceLevels,
      previousSignals: channel.signals,
      previousFingerprint: channel.lastSignalFingerprint,
      proximityThresholdRatio: settings.proximityThresholdRatio,
      signalLimit: SIGNAL_LIMIT,
    });

    channel.signals = signalResult.signals;
    channel.lastSignalFingerprint = signalResult.fingerprint;
  }

  private buildSnapshot(channel: MarketChannelState): MarketSnapshot {
    const depthState = this.symbolDepth.get(channel.symbol);

    return {
      symbol: channel.symbol,
      interval: channel.interval,
      candles: channel.candles,
      currentPrice: channel.currentPrice,
      latestBand: channel.latestBand,
      supportResistanceLevels: channel.supportResistanceLevels,
      orderBook: depthState?.orderBook ?? { bids: [], asks: [] },
      signals: channel.signals,
    };
  }

  private ensureKlineSocket(channel: MarketChannelState): void {
    if (this.klineSockets.has(channel.key)) {
      return;
    }

    const socket = new WebSocket(
      `${WS_BASE_URL}/${channel.symbol.toLowerCase()}@kline_${channel.interval}`
    );
    this.klineSockets.set(channel.key, socket);

    socket.on('open', () => {
      marketLogger.info({ channel: channel.key }, 'Market kline stream connected');
    });

    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as {
          k?: {
            t: number;
            o: string;
            h: string;
            l: string;
            c: string;
            v: string;
          };
        };

        if (!payload.k) {
          return;
        }

        const candle: Candle = {
          timestamp: payload.k.t,
          open: Number.parseFloat(payload.k.o),
          high: Number.parseFloat(payload.k.h),
          low: Number.parseFloat(payload.k.l),
          close: Number.parseFloat(payload.k.c),
          volume: Number.parseFloat(payload.k.v),
        };

        if (
          !Number.isFinite(candle.timestamp) ||
          !Number.isFinite(candle.open) ||
          !Number.isFinite(candle.high) ||
          !Number.isFinite(candle.low) ||
          !Number.isFinite(candle.close) ||
          !Number.isFinite(candle.volume)
        ) {
          return;
        }

        const state = this.channels.get(channel.key);
        if (!state) {
          return;
        }

        const settings = INTERVAL_SETTINGS[state.interval];
        state.candles = upsertCandle(state.candles, candle, settings.historyLimit);
        state.currentPrice = candle.close;
        this.recomputeDerivedState(state, settings);

        this.emit('kline_update', {
          symbol: state.symbol,
          interval: state.interval,
          payload: {
            candle,
            currentPrice: candle.close,
            latestBand: state.latestBand,
            supportResistanceLevels: state.supportResistanceLevels,
            signals: state.signals,
          },
        } as KlineUpdateEvent);
      } catch (error) {
        marketLogger.error({ error, channel: channel.key }, 'Failed to parse market kline message');
      }
    });

    socket.on('close', () => {
      this.klineSockets.delete(channel.key);
      if (channel.refCount > 0) {
        this.scheduleKlineReconnect(channel.key);
      }
    });

    socket.on('error', (error) => {
      marketLogger.warn({ error, channel: channel.key }, 'Market kline stream error');
    });
  }

  private ensureDepthSocket(symbol: string): void {
    if (this.depthSockets.has(symbol)) {
      return;
    }

    const socket = new WebSocket(`${WS_BASE_URL}/${symbol.toLowerCase()}@depth20@100ms`);
    this.depthSockets.set(symbol, socket);

    socket.on('open', () => {
      marketLogger.info({ symbol }, 'Market depth stream connected');
    });

    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as {
          bids?: string[][];
          asks?: string[][];
        };

        if (!payload.bids || !payload.asks) {
          return;
        }

        const depthState = this.symbolDepth.get(symbol);
        if (!depthState) {
          return;
        }

        depthState.orderBook = {
          asks: toOrderBookLevels(payload.asks).reverse(),
          bids: toOrderBookLevels(payload.bids),
        };

        this.emit('depth_update', {
          symbol,
          payload: {
            orderBook: depthState.orderBook,
          },
        } as DepthUpdateEvent);
      } catch (error) {
        marketLogger.error({ error, symbol }, 'Failed to parse market depth message');
      }
    });

    socket.on('close', () => {
      this.depthSockets.delete(symbol);
      const depthState = this.symbolDepth.get(symbol);
      if (depthState && depthState.refCount > 0) {
        this.scheduleDepthReconnect(symbol);
      }
    });

    socket.on('error', (error) => {
      marketLogger.warn({ error, symbol }, 'Market depth stream error');
    });
  }

  private scheduleKlineReconnect(channelKey: string): void {
    if (this.klineReconnectTimers.has(channelKey)) {
      return;
    }

    const timer = setTimeout(() => {
      this.klineReconnectTimers.delete(channelKey);
      const channel = this.channels.get(channelKey);
      if (!channel || channel.refCount === 0) {
        return;
      }

      this.ensureKlineSocket(channel);
    }, 2000);

    this.klineReconnectTimers.set(channelKey, timer);
  }

  private scheduleDepthReconnect(symbol: string): void {
    if (this.depthReconnectTimers.has(symbol)) {
      return;
    }

    const timer = setTimeout(() => {
      this.depthReconnectTimers.delete(symbol);
      const depthState = this.symbolDepth.get(symbol);
      if (!depthState || depthState.refCount === 0) {
        return;
      }

      this.ensureDepthSocket(symbol);
    }, 2000);

    this.depthReconnectTimers.set(symbol, timer);
  }

  private closeKlineSocket(channelKey: string): void {
    const socket = this.klineSockets.get(channelKey);
    if (socket) {
      socket.close();
      this.klineSockets.delete(channelKey);
    }

    const timer = this.klineReconnectTimers.get(channelKey);
    if (timer) {
      clearTimeout(timer);
      this.klineReconnectTimers.delete(channelKey);
    }
  }

  private closeDepthSocket(symbol: string): void {
    const socket = this.depthSockets.get(symbol);
    if (socket) {
      socket.close();
      this.depthSockets.delete(symbol);
    }

    const timer = this.depthReconnectTimers.get(symbol);
    if (timer) {
      clearTimeout(timer);
      this.depthReconnectTimers.delete(symbol);
    }
  }

  private async fetchHistoricalCandles(
    symbol: string,
    interval: KlineInterval,
    limit: number
  ): Promise<Candle[]> {
    const urls = this.getPreferredBaseUrls();
    const params = new URLSearchParams({
      symbol,
      interval,
      limit: `${limit}`,
    });

    let lastError: unknown = null;

    for (const baseUrl of urls) {
      const requestUrl = `${baseUrl}/api/v3/klines?${params.toString()}`;

      try {
        const response = await this.fetchWithTimeout(requestUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as unknown;
        if (!Array.isArray(payload)) {
          throw new Error('Invalid klines response payload');
        }

        const candles = payload
          .map((item): Candle | null => {
            if (!Array.isArray(item) || item.length < 6) {
              return null;
            }

            const timestamp = Number(item[0]);
            const open = Number.parseFloat(String(item[1]));
            const high = Number.parseFloat(String(item[2]));
            const low = Number.parseFloat(String(item[3]));
            const close = Number.parseFloat(String(item[4]));
            const volume = Number.parseFloat(String(item[5]));

            if (
              !Number.isFinite(timestamp) ||
              !Number.isFinite(open) ||
              !Number.isFinite(high) ||
              !Number.isFinite(low) ||
              !Number.isFinite(close) ||
              !Number.isFinite(volume)
            ) {
              return null;
            }

            return {
              timestamp,
              open,
              high,
              low,
              close,
              volume,
            };
          })
          .filter((item): item is Candle => item !== null);

        if (candles.length === 0) {
          throw new Error('Received empty candle dataset');
        }

        this.preferredBaseUrl = baseUrl;
        return candles;
      } catch (error) {
        lastError = error;
        marketLogger.warn({ error, baseUrl, symbol, interval }, 'Market snapshot request failed');
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to fetch market candles');
  }

  private getPreferredBaseUrls(): string[] {
    if (!this.preferredBaseUrl) {
      return this.binanceBaseUrls;
    }

    return [
      this.preferredBaseUrl,
      ...this.binanceBaseUrls.filter((baseUrl) => baseUrl !== this.preferredBaseUrl),
    ];
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.restTimeoutMs);

    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
