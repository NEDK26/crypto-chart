export type KlineInterval = '1m' | '5m' | '1h' | '4h' | '1d';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BollingerBandPoint {
  timestamp: number;
  upper: number;
  middle: number;
  lower: number;
}

export type LevelType = 'support' | 'resistance';

export type LevelTier = 'strong' | 'mid' | 'weak';

export interface PriceLevel {
  id: string;
  type: LevelType;
  sourceType?: LevelType;
  isFlipped?: boolean;
  price: number;
  sourceTimestamp?: number;
  zoneLow?: number;
  zoneHigh?: number;
  rank?: number;
  tier?: LevelTier;
  distancePct?: number;
  isNear?: boolean;
  touches: number;
  strength: number;
  lastTouchedAt: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
  notional: number;
}

export interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export type SignalType = 'breakout_up' | 'breakout_down' | 'support_touch' | 'resistance_touch';

export interface SignalEvent {
  id: string;
  timestamp: number;
  price: number;
  type: SignalType;
  description: string;
}

export interface MarketSnapshot {
  symbol: string;
  interval: KlineInterval;
  candles: Candle[];
  currentPrice: number | null;
  latestBand: BollingerBandPoint | null;
  supportResistanceLevels: PriceLevel[];
  orderBook: OrderBookSnapshot;
  signals: SignalEvent[];
}

export interface MarketKlineUpdatePayload {
  candle: Candle;
  currentPrice: number;
  latestBand: BollingerBandPoint | null;
  supportResistanceLevels: PriceLevel[];
  signals: SignalEvent[];
}

export interface MarketDepthUpdatePayload {
  orderBook: OrderBookSnapshot;
}

export type MarketServerEvent =
  | {
      type: 'snapshot';
      symbol: string;
      interval: KlineInterval;
      payload: MarketSnapshot;
    }
  | {
      type: 'kline_update';
      symbol: string;
      interval: KlineInterval;
      payload: MarketKlineUpdatePayload;
    }
  | {
      type: 'depth_update';
      symbol: string;
      payload: MarketDepthUpdatePayload;
    }
  | {
      type: 'error';
      payload: {
        message: string;
      };
    };

export type MarketClientCommand =
  | {
      type: 'subscribe';
      symbol: string;
      interval: KlineInterval;
    }
  | {
      type: 'unsubscribe';
      symbol: string;
      interval: KlineInterval;
    };
