import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionType, LineType, dispose, init, type Chart, type Crosshair, type Point } from 'klinecharts';
import { calculateBollingerBands } from '../quant/bollinger';
import { calculateSupportResistance } from '../quant/supportResistance';
import type {
  Candle,
  OrderBookLevel,
  OrderBookSnapshot,
  PriceLevel,
  SignalEvent,
  SignalType,
} from '../types/market';
import './QuantChartDashboard.css';

const HISTORICAL_LIMIT = 500;
const ORDERBOOK_DEPTH = 12;
const SIGNAL_LIMIT = 16;
const TARGET_VOLUME_RATIO = 0.24;
const MAX_VOLUME_PANE_HEIGHT = 160;
const MIN_VOLUME_PANE_HEIGHT = 72;
const BOLLINGER_INDICATOR_NAME = 'BOLL';
const CANDLE_PANE_ID = 'candle_pane';
const SUPPORT_RESISTANCE_GROUP = 'sr-levels';

type KlineInterval = '1m' | '5m' | '1h' | '4h' | '1d';
type MarketSymbol = 'BTCUSDC' | 'ETHUSDC';

const INTERVAL_OPTIONS: Array<{ value: KlineInterval; label: string }> = [
  { value: '1m', label: '1分' },
  { value: '5m', label: '5分' },
  { value: '1h', label: '1小时' },
  { value: '4h', label: '4小时' },
  { value: '1d', label: '1天' },
];

const SYMBOL_OPTIONS: Array<{ value: MarketSymbol; label: string }> = [
  { value: 'BTCUSDC', label: 'BTC / USDC' },
  { value: 'ETHUSDC', label: 'ETH / USDC' },
];

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const hoverTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

interface BinanceKlinePayload {
  k?: {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
  };
}

interface BinanceDepthPayload {
  bids?: string[][];
  asks?: string[][];
}

interface HoverCandleInfo {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  changePercent: number;
}

function toOrderBookLevels(levels: string[][]): OrderBookLevel[] {
  return levels.map((level) => {
    const price = Number.parseFloat(level[0]);
    const quantity = Number.parseFloat(level[1]);

    return {
      price,
      quantity,
      notional: price * quantity,
    };
  });
}

function upsertCandle(candles: Candle[], candle: Candle): Candle[] {
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
  if (next.length > HISTORICAL_LIMIT) {
    return next.slice(next.length - HISTORICAL_LIMIT);
  }

  return next;
}

function formatPrice(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--';
  }
  return value.toFixed(2);
}

function formatSignedDelta(value: number): string {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}%`;
}

function formatVolume(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--';
  }

  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }

  return value.toFixed(2);
}

function buildHoverCandleInfo(
  timestamp: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number | null
): HoverCandleInfo | null {
  if ([open, high, low, close].some((value) => Number.isNaN(value))) {
    return null;
  }

  const changePercent = open !== 0 ? ((close - open) / open) * 100 : 0;

  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    changePercent,
  };
}

function buildSignalEvent(type: SignalType, price: number, timestamp: number): SignalEvent {
  const descriptions: Record<SignalType, string> = {
    breakout_up: '价格向上突破布林上轨',
    breakout_down: '价格向下跌破布林下轨',
    support_touch: '价格接近支撑位，留意止跌确认',
    resistance_touch: '价格接近阻力位，留意量能突破',
  };

  return {
    id: `${type}-${timestamp}-${Math.round(price * 100)}`,
    type,
    price,
    timestamp,
    description: descriptions[type],
  };
}

function calculateVolumePaneHeight(containerHeight: number): number {
  if (containerHeight <= 0) {
    return 0;
  }

  const upperBound = Math.min(MAX_VOLUME_PANE_HEIGHT, Math.floor(containerHeight / 3));
  const lowerBound = Math.min(MIN_VOLUME_PANE_HEIGHT, upperBound);
  const target = Math.round(containerHeight * TARGET_VOLUME_RATIO);

  return Math.max(lowerBound, Math.min(target, upperBound));
}

export default function QuantChartDashboard() {
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const volumePaneIdRef = useRef<string | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const lastHoverKeyRef = useRef<string | null>(null);
  const klineWsRef = useRef<WebSocket | null>(null);
  const depthWsRef = useRef<WebSocket | null>(null);
  const lastSignalFingerprintRef = useRef<string | null>(null);

  const [chartReady, setChartReady] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [orderBook, setOrderBook] = useState<OrderBookSnapshot>({ bids: [], asks: [] });
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [hoverCandle, setHoverCandle] = useState<HoverCandleInfo | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<MarketSymbol>('BTCUSDC');
  const [selectedInterval, setSelectedInterval] = useState<KlineInterval>('1m');

  const bollingerSeries = useMemo(() => {
    return calculateBollingerBands(candles, {
      period: 20,
      stdDevMultiplier: 2,
    });
  }, [candles]);

  const supportResistanceLevels = useMemo(() => {
    return calculateSupportResistance(candles, {
      pivotWindow: 3,
      clusterTolerance: 0.003,
      maxLevelsPerType: 4,
    });
  }, [candles]);

  const supportLevels = supportResistanceLevels.filter((level) => level.type === 'support');
  const resistanceLevels = supportResistanceLevels.filter((level) => level.type === 'resistance');

  const latestBand = bollingerSeries.length > 0 ? bollingerSeries[bollingerSeries.length - 1] : null;
  const previousClose = candles.length > 1 ? candles[candles.length - 2].close : null;
  const livePrice = currentPrice ?? (candles.length > 0 ? candles[candles.length - 1].close : null);

  const priceDeltaPercent =
    livePrice !== null && previousClose !== null && previousClose !== 0
      ? ((livePrice - previousClose) / previousClose) * 100
      : 0;

  const selectedIntervalLabel =
    INTERVAL_OPTIONS.find((option) => option.value === selectedInterval)?.label ?? selectedInterval;
  const selectedSymbolLabel =
    SYMBOL_OPTIONS.find((option) => option.value === selectedSymbol)?.label ?? selectedSymbol;

  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    if (!chartContainerRef.current) {
      return;
    }

    const container = chartContainerRef.current;

    setCandles([]);
    setSignals([]);
    setCurrentPrice(null);
    setOrderBook({ bids: [], asks: [] });
    candlesRef.current = [];
    setHoverCandle(null);
    lastHoverKeyRef.current = null;
    lastSignalFingerprintRef.current = null;

    const chart = init(container, {
      styles: {
        grid: {
          show: true,
          horizontal: {
            show: true,
            style: LineType.Solid,
            size: 1,
            color: 'rgba(235, 245, 255, 0.05)',
            dashedValue: [],
          },
          vertical: {
            show: false,
            style: LineType.Solid,
            size: 1,
            color: 'rgba(235, 245, 255, 0.03)',
            dashedValue: [],
          },
        },
        xAxis: {
          axisLine: {
            show: false,
            color: 'rgba(0, 0, 0, 0)',
            size: 0,
          },
          tickLine: {
            show: false,
            color: 'rgba(0, 0, 0, 0)',
            size: 0,
            length: 0,
          },
        },
        yAxis: {
          axisLine: {
            show: false,
            color: 'rgba(0, 0, 0, 0)',
            size: 0,
          },
          tickLine: {
            show: false,
            color: 'rgba(0, 0, 0, 0)',
            size: 0,
            length: 0,
          },
        },
        crosshair: {
          vertical: {
            show: false,
          },
        },
      },
    });
    chartRef.current = chart;

    const handleCrosshairChange = (payload?: unknown) => {
      const crosshair = payload as Crosshair | undefined;
      const hovered = crosshair?.kLineData;

      if (!hovered) {
        lastHoverKeyRef.current = null;
        setHoverCandle(null);
        return;
      }

      const nextHover = buildHoverCandleInfo(
        hovered.timestamp,
        Number(hovered.open),
        Number(hovered.high),
        Number(hovered.low),
        Number(hovered.close),
        typeof hovered.volume === 'number' ? hovered.volume : null
      );

      if (!nextHover) {
        lastHoverKeyRef.current = null;
        setHoverCandle(null);
        return;
      }

      const hoverKey = `${nextHover.timestamp}-${nextHover.close}`;
      if (lastHoverKeyRef.current === hoverKey) {
        return;
      }

      lastHoverKeyRef.current = hoverKey;
      setHoverCandle(nextHover);
    };

    const handleMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        return;
      }

      let converted: Partial<Point> | Array<Partial<Point>>;

      try {
        converted = chart.convertFromPixel(
          [{ x, y }],
          {
            paneId: CANDLE_PANE_ID,
          }
        ) as Partial<Point> | Array<Partial<Point>>;
      } catch {
        return;
      }

      const point = Array.isArray(converted) ? converted[0] : converted;
      const dataIndex = typeof point?.dataIndex === 'number' ? point.dataIndex : undefined;

      if (dataIndex === undefined) {
        return;
      }

      const candle = candlesRef.current[dataIndex];
      if (!candle) {
        return;
      }

      const nextHover = buildHoverCandleInfo(
        candle.timestamp,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume
      );

      if (!nextHover) {
        return;
      }

      const hoverKey = `${nextHover.timestamp}-${nextHover.close}`;
      if (lastHoverKeyRef.current === hoverKey) {
        return;
      }

      lastHoverKeyRef.current = hoverKey;
      setHoverCandle(nextHover);
    };

    const handleMouseLeave = () => {
      lastHoverKeyRef.current = null;
      setHoverCandle(null);
    };

    chart.subscribeAction(ActionType.OnCrosshairChange, handleCrosshairChange);
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseleave', handleMouseLeave);

    const syncVolumePaneSize = () => {
      if (!chartContainerRef.current || !chartRef.current || !volumePaneIdRef.current) {
        return;
      }

      const volumeHeight = calculateVolumePaneHeight(chartContainerRef.current.clientHeight);
      if (volumeHeight <= 0) {
        return;
      }

      chartRef.current.setPaneOptions({
        id: volumePaneIdRef.current,
        height: volumeHeight,
        minHeight: Math.min(Math.max(56, Math.floor(volumeHeight * 0.72)), volumeHeight),
      });
    };

    chart.setPriceVolumePrecision(2, 4);

    const volumePaneId = chart.createIndicator('VOL', false);
    if (volumePaneId) {
      volumePaneIdRef.current = volumePaneId;
      syncVolumePaneSize();
    }
    chart.createIndicator({ name: 'EMA', calcParams: [20] }, false, { id: CANDLE_PANE_ID });
    chart.createIndicator(
      {
        name: BOLLINGER_INDICATOR_NAME,
        calcParams: [20, 2],
      },
      false,
      {
        id: CANDLE_PANE_ID,
      }
    );
    chart.resize();
    requestAnimationFrame(() => {
      syncVolumePaneSize();
      chartRef.current?.resize();
    });
    setChartReady(true);

    let mounted = true;

    const connectKlineStream = () => {
      const socket = new WebSocket(
        `wss://stream.binance.com:9443/ws/${selectedSymbol.toLowerCase()}@kline_${selectedInterval}`
      );
      klineWsRef.current = socket;

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as BinanceKlinePayload;
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

        chartRef.current?.updateData(candle);
        setCandles((previous) => {
          const next = upsertCandle(previous, candle);
          candlesRef.current = next;
          return next;
        });
        setCurrentPrice(candle.close);
      };
    };

    const connectDepthStream = () => {
      const socket = new WebSocket(
        `wss://stream.binance.com:9443/ws/${selectedSymbol.toLowerCase()}@depth20@100ms`
      );
      depthWsRef.current = socket;

      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as BinanceDepthPayload;

        if (!payload.bids || !payload.asks) {
          return;
        }

        const asks = toOrderBookLevels(payload.asks.slice(0, ORDERBOOK_DEPTH)).reverse();
        const bids = toOrderBookLevels(payload.bids.slice(0, ORDERBOOK_DEPTH));

        setOrderBook({ asks, bids });
      };
    };

    const loadInitialCandles = async () => {
      try {
        const response = await fetch(
          `https://api.binance.com/api/v3/klines?symbol=${selectedSymbol}&interval=${selectedInterval}&limit=${HISTORICAL_LIMIT}`
        );

        if (!response.ok) {
          throw new Error(`Binance API returned ${response.status}`);
        }

        const payload = (await response.json()) as Array<
          [number, string, string, string, string, string]
        >;

        if (!mounted) {
          return;
        }

        const formatted = payload.map((item) => ({
          timestamp: item[0],
          open: Number.parseFloat(item[1]),
          high: Number.parseFloat(item[2]),
          low: Number.parseFloat(item[3]),
          close: Number.parseFloat(item[4]),
          volume: Number.parseFloat(item[5]),
        }));

        chart.applyNewData(formatted);
        candlesRef.current = formatted;
        setCandles(formatted);

        const last = formatted[formatted.length - 1];
        if (last) {
          setCurrentPrice(last.close);
        }

        connectKlineStream();
        connectDepthStream();
      } catch (error) {
        console.error('Failed to load Binance historical candles', error);
      }
    };

    loadInitialCandles();

    const handleResize = () => {
      syncVolumePaneSize();
      chartRef.current?.resize();
    };

    window.addEventListener('resize', handleResize);

    return () => {
      mounted = false;
      window.removeEventListener('resize', handleResize);

      chart.unsubscribeAction(ActionType.OnCrosshairChange, handleCrosshairChange);
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseleave', handleMouseLeave);

      klineWsRef.current?.close();
      depthWsRef.current?.close();

      if (chartContainerRef.current) {
        dispose(chartContainerRef.current);
      }

      chartRef.current = null;
      volumePaneIdRef.current = null;
      lastHoverKeyRef.current = null;
      setChartReady(false);
      setHoverCandle(null);
    };
  }, [selectedInterval, selectedSymbol]);

  useEffect(() => {
    if (!chartReady || !chartRef.current) {
      return;
    }

    const chart = chartRef.current;
    chart.removeOverlay({ groupId: SUPPORT_RESISTANCE_GROUP });

    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) {
      return;
    }

    const visibleLevels = supportResistanceLevels;

    if (visibleLevels.length === 0) {
      return;
    }

    chart.createOverlay(
      visibleLevels.map((level) => ({
        name: 'horizontalStraightLine',
        groupId: SUPPORT_RESISTANCE_GROUP,
        lock: true,
        points: [{ timestamp: lastCandle.timestamp, value: level.price }],
        styles: {
          line: {
            color: level.type === 'support' ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 214, 64, 0.95)',
            size: 1,
            style: LineType.Solid,
            dashedValue: [],
            smooth: false,
          },
        },
      }))
    );
  }, [candles, chartReady, supportResistanceLevels]);

  useEffect(() => {
    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) {
      return;
    }

    const threshold = lastCandle.close * 0.0012;

    const nearestSupport = supportLevels
      .filter((level) => level.price <= lastCandle.close)
      .sort((left, right) => right.price - left.price)[0];

    const nearestResistance = resistanceLevels
      .filter((level) => level.price >= lastCandle.close)
      .sort((left, right) => left.price - right.price)[0];

    let nextSignal: SignalEvent | null = null;

    if (latestBand && lastCandle.close > latestBand.upper) {
      nextSignal = buildSignalEvent('breakout_up', lastCandle.close, lastCandle.timestamp);
    } else if (latestBand && lastCandle.close < latestBand.lower) {
      nextSignal = buildSignalEvent('breakout_down', lastCandle.close, lastCandle.timestamp);
    } else if (nearestSupport && Math.abs(lastCandle.close - nearestSupport.price) <= threshold) {
      nextSignal = buildSignalEvent('support_touch', nearestSupport.price, lastCandle.timestamp);
    } else if (nearestResistance && Math.abs(lastCandle.close - nearestResistance.price) <= threshold) {
      nextSignal = buildSignalEvent('resistance_touch', nearestResistance.price, lastCandle.timestamp);
    }

    if (!nextSignal) {
      return;
    }

    const fingerprint = `${nextSignal.type}-${Math.round(nextSignal.price * 100)}-${Math.floor(
      nextSignal.timestamp / 60000
    )}`;

    if (lastSignalFingerprintRef.current === fingerprint) {
      return;
    }

    lastSignalFingerprintRef.current = fingerprint;

    setSignals((previous) => {
      return [nextSignal, ...previous].slice(0, SIGNAL_LIMIT);
    });
  }, [candles, latestBand, resistanceLevels, supportLevels]);

  return (
    <div className="quant-page">
      <header className="quant-header">
        <div>
          <div className="symbol-selector">
            <label htmlFor="market-symbol-select">交易对</label>
            <select
              id="market-symbol-select"
              value={selectedSymbol}
              onChange={(event) => setSelectedSymbol(event.target.value as MarketSymbol)}
            >
              {SYMBOL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <h1>{selectedSymbolLabel}</h1>
          <p>{`Quant Visual Console · ${selectedIntervalLabel} 周期`}</p>
        </div>

        <div className="price-flag" data-direction={priceDeltaPercent >= 0 ? 'up' : 'down'}>
          <strong>${formatPrice(livePrice)}</strong>
          <span>{formatSignedDelta(priceDeltaPercent)}</span>
        </div>

        <div className="interval-list">
          {INTERVAL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={selectedInterval === option.value ? 'active' : ''}
              onClick={() => setSelectedInterval(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <section className="quant-workspace">
        <article className="chart-card">
          <div className="chart-frame" ref={chartContainerRef} />
          <div className="chart-hover-strip" data-visible={hoverCandle ? 'true' : 'false'}>
            <span className="chart-hover-title">OHLCV</span>
            {hoverCandle ? (
              <>
                <span className="chart-hover-time">{hoverTimeFormatter.format(hoverCandle.timestamp)}</span>
                <span className="chart-hover-metric">
                  <em>O</em>
                  <strong>{hoverCandle.open.toFixed(2)}</strong>
                </span>
                <span className="chart-hover-metric">
                  <em>H</em>
                  <strong>{hoverCandle.high.toFixed(2)}</strong>
                </span>
                <span className="chart-hover-metric">
                  <em>L</em>
                  <strong>{hoverCandle.low.toFixed(2)}</strong>
                </span>
                <span className="chart-hover-metric">
                  <em>C</em>
                  <strong>{hoverCandle.close.toFixed(2)}</strong>
                </span>
                <span className="chart-hover-metric">
                  <em>V</em>
                  <strong>{formatVolume(hoverCandle.volume)}</strong>
                </span>
                <span
                  className={`chart-hover-metric chart-hover-change ${
                    hoverCandle.changePercent >= 0 ? 'up' : 'down'
                  }`}
                >
                  <em>涨跌幅</em>
                  <strong>{formatSignedDelta(hoverCandle.changePercent)}</strong>
                </span>
              </>
            ) : (
              <span className="chart-hover-placeholder">悬浮到K线上可查看 OHLCV 与涨跌幅</span>
            )}
          </div>
        </article>

        <aside className="insight-panel">
          <section className="panel-card">
            <h2>布林带快照</h2>
            <div className="metric-grid">
              <div>
                <span>上轨</span>
                <strong>{formatPrice(latestBand?.upper ?? null)}</strong>
              </div>
              <div>
                <span>中轨</span>
                <strong>{formatPrice(latestBand?.middle ?? null)}</strong>
              </div>
              <div>
                <span>下轨</span>
                <strong>{formatPrice(latestBand?.lower ?? null)}</strong>
              </div>
            </div>
          </section>

          <section className="panel-card">
            <h2>关键价位</h2>
            <div className="level-list">
              {supportResistanceLevels.length === 0 ? (
                <p className="empty-hint">历史数据不足，等待形成结构点。</p>
              ) : (
                supportResistanceLevels.map((level: PriceLevel) => (
                  <div key={level.id} className={`level-item ${level.type}`}>
                    <span>{level.type === 'support' ? '支撑' : '阻力'}</span>
                    <strong>{formatPrice(level.price)}</strong>
                    <small>{`触发 ${level.touches} 次`}</small>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel-card orderbook-card">
            <h2>盘口深度</h2>
            <div className="orderbook-head">
              <span>价格</span>
              <span>数量</span>
              <span>名义</span>
            </div>
            <div className="orderbook-body">
              {orderBook.asks.map((item, index) => (
                <div key={`ask-${index}-${item.price}`} className="order-row ask">
                  <span>{item.price.toFixed(2)}</span>
                  <span>{item.quantity.toFixed(4)}</span>
                  <span>{item.notional.toFixed(0)}</span>
                </div>
              ))}

              <div className="order-mid">{formatPrice(livePrice)}</div>

              {orderBook.bids.map((item, index) => (
                <div key={`bid-${index}-${item.price}`} className="order-row bid">
                  <span>{item.price.toFixed(2)}</span>
                  <span>{item.quantity.toFixed(4)}</span>
                  <span>{item.notional.toFixed(0)}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>

      <section className="signals-card">
        <h2>信号流</h2>
        <div className="signals-list">
          {signals.length === 0 ? (
            <p className="empty-hint">暂无触发信号，保持观察。</p>
          ) : (
            signals.map((signal) => (
              <div key={signal.id} className={`signal-item ${signal.type}`}>
                <span>{timeFormatter.format(signal.timestamp)}</span>
                <strong>{formatPrice(signal.price)}</strong>
                <p>{signal.description}</p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
