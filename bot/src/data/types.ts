export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface Order {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  price?: number;
  orderId?: number;
  status?: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'PENDING';
  priceAvg?: number;
  time?: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  entryPrice: number;
  unrealizedPnl: number;
}

export interface TradeSignal {
  strategy: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  price: number;
  timestamp: number;
  reason?: string;
}

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  timestamp: number;
  klines: Kline[];
}
