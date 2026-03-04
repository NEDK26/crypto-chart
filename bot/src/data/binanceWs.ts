import WebSocket from 'ws';
import { logger } from '../monitor/logger.js';
import { Kline } from './types.js';

export type KlineCallback = (kline: Kline) => void;

export class BinanceWsClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 3000;
  private callbacks: KlineCallback[] = [];

  connect(streams: string[]): void {
    const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info({ streams }, 'WebSocket connected');
      this.reconnectAttempts = 0;
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        logger.error({ error }, 'Failed to parse WebSocket message');
      }
    });

    this.ws.on('close', () => {
      logger.warn('WebSocket disconnected');
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      logger.error({ error }, 'WebSocket error');
    });
  }

  private handleMessage(message: { stream?: string; data?: unknown }): void {
    if (message.stream && message.data) {
      const data = message.data as {
        k: {
          t: number;
          o: string;
          h: string;
          l: string;
          c: string;
          v: string;
          x: boolean;
        };
      };

      if (data.k.x) {
        const kline: Kline = {
          time: data.k.t,
          open: parseFloat(data.k.o),
          high: parseFloat(data.k.h),
          low: parseFloat(data.k.l),
          close: parseFloat(data.k.c),
          volume: parseFloat(data.k.v),
          closeTime: data.k.t + 60000,
        };

        this.callbacks.forEach((cb) => cb(kline));
      }
    }
  }

  private reconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    logger.info(
      { attempt: this.reconnectAttempts },
      'Attempting to reconnect...'
    );

    setTimeout(() => {
      this.connect([
        'btcusdt@kline_1m',
        'btcusdt@depth20@100ms',
      ]);
    }, this.reconnectDelay);
  }

  onKline(callback: KlineCallback): void {
    this.callbacks.push(callback);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
