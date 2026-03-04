import axios, { AxiosInstance } from 'axios';
import { createHmac } from 'crypto';
import { getConfig } from '../config/index.js';
import { logger } from '../monitor/logger.js';
import { Order, Kline, AccountBalance } from './types.js';

export class BinanceApiClient {
  private client: AxiosInstance;
  private apiKey: string;
  private secretKey: string;

  constructor() {
    const config = getConfig();
    this.apiKey = config.BINANCE_API_KEY;
    this.secretKey = config.BINANCE_SECRET_KEY;

    this.client = axios.create({
      baseURL: 'https://api.binance.com',
      timeout: 10000,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
    });
  }

  private sign(queryString: string): string {
    return createHmac('sha256', this.secretKey)
      .update(queryString)
      .digest('hex');
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    const timestamp = Date.now();
    const queryParams = new URLSearchParams({
      timestamp: timestamp.toString(),
      ...(params && Object.fromEntries(
        Object.entries(params).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, v.toString()])
      )),
    });

    const signature = this.sign(queryParams.toString());
    const url = `${endpoint}?${queryParams}&signature=${signature}`;

    try {
      const response = await this.client.request<T>({
        method,
        url,
      });
      return response.data;
    } catch (error) {
      logger.error({ error, endpoint, params }, 'API request failed');
      throw error;
    }
  }

  async getKlines(
    symbol: string,
    interval: string,
    limit: number = 500
  ): Promise<Kline[]> {
    const response = await this.client.get<unknown[]>('/api/v3/klines', {
      params: { symbol, interval, limit },
    });

    return response.data.map((k) => ({
      time: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
      closeTime: k[6] as number,
    }));
  }

  async getAccountBalance(): Promise<AccountBalance[]> {
    const response = await this.signedRequest<{ balances: AccountBalance[] }>(
      'GET',
      '/api/v3/account',
      {}
    );
    return response.balances;
  }

  async placeOrder(order: Order): Promise<Order> {
    const params: Record<string, string | number | undefined> = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
    };

    if (order.type === 'LIMIT' && order.price) {
      params.price = order.price;
      params.timeInForce = 'GTC';
    }

    const response = await this.signedRequest<{
      orderId: number;
      status: string;
      price: string;
      executedQty: string;
      time: number;
    }>('POST', '/api/v3/order', params);

    return {
      ...order,
      orderId: response.orderId,
      status: response.status as Order['status'],
      priceAvg: parseFloat(response.price),
      time: response.time,
    };
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    await this.signedRequest('DELETE', '/api/v3/order', {
      symbol,
      orderId,
    });
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const params = symbol ? { symbol } : {};
    const response = await this.signedRequest<Order[]>('GET', '/api/v3/openOrders', params);
    return response;
  }
}

export const binanceApi = new BinanceApiClient();
