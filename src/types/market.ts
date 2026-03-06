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

export type SignalType =
  | 'breakout_up'
  | 'breakout_down'
  | 'support_touch'
  | 'resistance_touch';

export interface SignalEvent {
  id: string;
  timestamp: number;
  price: number;
  type: SignalType;
  description: string;
}
