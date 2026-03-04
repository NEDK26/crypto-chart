import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ActionType, LineType, dispose, init, type Chart, type Crosshair, type Point } from 'klinecharts';
import type {
  BollingerBandPoint,
  Candle,
  OrderBookSnapshot,
  PriceLevel,
  SignalEvent,
} from '../types/market';
import './QuantChartDashboard.css';

const TARGET_VOLUME_RATIO = 0.24;
const MAX_VOLUME_PANE_HEIGHT = 160;
const MIN_VOLUME_PANE_HEIGHT = 72;
const BOLLINGER_INDICATOR_NAME = 'BOLL';
const CANDLE_PANE_ID = 'candle_pane';
const SUPPORT_RESISTANCE_GROUP = 'sr-levels';
const SUPPORT_LINE_COLOR = 'rgba(103, 236, 182, 0.95)';
const RESISTANCE_LINE_COLOR = 'rgba(255, 149, 170, 0.95)';
const MARKET_SNAPSHOT_ENDPOINT = '/api/market/snapshot';
const MARKET_WS_ENDPOINT = '/ws/market';

type KlineInterval = '1m' | '5m' | '1h' | '4h' | '1d';
type MarketSymbol = 'BTCUSDC' | 'ETHUSDC';
type InsightWidgetId = 'bollinger' | 'levels' | 'orderbook' | 'signals';

interface InsightWidgetConfig {
  id: InsightWidgetId;
  title: string;
  cardClassName?: string;
}

interface SortableInsightCardProps {
  id: InsightWidgetId;
  title: string;
  locked: boolean;
  cardClassName?: string;
  children: ReactNode;
}

const INSIGHT_WIDGET_ORDER_STORAGE_KEY = 'quant-insight-widget-order-v1';
const INSIGHT_LAYOUT_LOCK_STORAGE_KEY = 'quant-insight-layout-lock-v1';
const INSIGHT_WIDGET_CONFIGS: InsightWidgetConfig[] = [
  { id: 'bollinger', title: '布林带快照' },
  { id: 'levels', title: '关键价位' },
  { id: 'orderbook', title: '盘口深度', cardClassName: 'orderbook-card' },
  { id: 'signals', title: '信号流', cardClassName: 'signals-card' },
];
const DEFAULT_INSIGHT_WIDGET_ORDER: InsightWidgetId[] = INSIGHT_WIDGET_CONFIGS.map(
  (widget) => widget.id
);
const INSIGHT_WIDGET_ID_SET = new Set<InsightWidgetId>(DEFAULT_INSIGHT_WIDGET_ORDER);

function normalizeInsightWidgetOrder(rawOrder: unknown): InsightWidgetId[] {
  if (!Array.isArray(rawOrder)) {
    return [...DEFAULT_INSIGHT_WIDGET_ORDER];
  }

  const nextOrder: InsightWidgetId[] = [];
  for (const item of rawOrder) {
    if (typeof item !== 'string') {
      continue;
    }

    const widgetId = item as InsightWidgetId;
    if (!INSIGHT_WIDGET_ID_SET.has(widgetId) || nextOrder.includes(widgetId)) {
      continue;
    }

    nextOrder.push(widgetId);
  }

  for (const widgetId of DEFAULT_INSIGHT_WIDGET_ORDER) {
    if (!nextOrder.includes(widgetId)) {
      nextOrder.push(widgetId);
    }
  }

  return nextOrder;
}

function loadInsightWidgetOrder(): InsightWidgetId[] {
  if (typeof window === 'undefined') {
    return [...DEFAULT_INSIGHT_WIDGET_ORDER];
  }

  try {
    const stored = window.localStorage.getItem(INSIGHT_WIDGET_ORDER_STORAGE_KEY);
    if (!stored) {
      return [...DEFAULT_INSIGHT_WIDGET_ORDER];
    }

    const parsed = JSON.parse(stored);
    return normalizeInsightWidgetOrder(parsed);
  } catch {
    return [...DEFAULT_INSIGHT_WIDGET_ORDER];
  }
}

function loadInsightLayoutLocked(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(INSIGHT_LAYOUT_LOCK_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function SortableInsightCard(props: SortableInsightCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: props.locked,
  });

  const classNames = ['panel-card', 'insight-card'];
  if (props.cardClassName) {
    classNames.push(props.cardClassName);
  }
  if (isDragging) {
    classNames.push('is-dragging');
  }

  return (
    <section
      ref={setNodeRef}
      className={classNames.join(' ')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="panel-card-head">
        <h2>{props.title}</h2>
        <button
          type="button"
          className="drag-handle"
          disabled={props.locked}
          aria-label={`${props.title}拖拽排序`}
          title={props.locked ? '布局已锁定' : '拖拽排序'}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
      </div>
      {props.children}
    </section>
  );
}

interface IntervalSettings {
  historyLimit: number;
  pivotWindow: number;
  clusterTolerance: number;
  maxLevelsPerType: number;
  proximityThresholdRatio: number;
}

const INTERVAL_SETTINGS: Record<KlineInterval, IntervalSettings> = {
  '1m': {
    historyLimit: 1000,
    pivotWindow: 5,
    clusterTolerance: 0.0016,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0009,
  },
  '5m': {
    historyLimit: 1000,
    pivotWindow: 3,
    clusterTolerance: 0.0028,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0011,
  },
  '1h': {
    historyLimit: 800,
    pivotWindow: 3,
    clusterTolerance: 0.003,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0016,
  },
  '4h': {
    historyLimit: 700,
    pivotWindow: 3,
    clusterTolerance: 0.0042,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0022,
  },
  '1d': {
    historyLimit: 500,
    pivotWindow: 2,
    clusterTolerance: 0.006,
    maxLevelsPerType: 4,
    proximityThresholdRatio: 0.0032,
  },
};

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

interface MarketSnapshot {
  symbol: string;
  interval: KlineInterval;
  candles: Candle[];
  currentPrice: number | null;
  latestBand: BollingerBandPoint | null;
  supportResistanceLevels: PriceLevel[];
  orderBook: OrderBookSnapshot;
  signals: SignalEvent[];
}

interface MarketKlineUpdate {
  candle: Candle;
  currentPrice: number;
  latestBand: BollingerBandPoint | null;
  supportResistanceLevels: PriceLevel[];
  signals: SignalEvent[];
}

type MarketServerEvent =
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
      payload: MarketKlineUpdate;
    }
  | {
      type: 'depth_update';
      symbol: string;
      payload: {
        orderBook: OrderBookSnapshot;
      };
    }
  | {
      type: 'error';
      payload: {
        message: string;
      };
    };

interface MarketClientCommand {
  type: 'subscribe' | 'unsubscribe';
  symbol: string;
  interval: KlineInterval;
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
  const marketWsRef = useRef<WebSocket | null>(null);

  const [chartReady, setChartReady] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [latestBand, setLatestBand] = useState<BollingerBandPoint | null>(null);
  const [supportResistanceLevels, setSupportResistanceLevels] = useState<PriceLevel[]>([]);
  const [orderBook, setOrderBook] = useState<OrderBookSnapshot>({ bids: [], asks: [] });
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [hoverCandle, setHoverCandle] = useState<HoverCandleInfo | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<MarketSymbol>('BTCUSDC');
  const [selectedInterval, setSelectedInterval] = useState<KlineInterval>('1m');
  const [showSupportResistanceLines, setShowSupportResistanceLines] = useState(true);
  const [insightWidgetOrder, setInsightWidgetOrder] = useState<InsightWidgetId[]>(() =>
    loadInsightWidgetOrder()
  );
  const [insightLayoutLocked, setInsightLayoutLocked] = useState(() => loadInsightLayoutLocked());

  const intervalSettings = INTERVAL_SETTINGS[selectedInterval];
  const historyLimit = intervalSettings.historyLimit;
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

  const insightWidgetConfigMap = useMemo(() => {
    return INSIGHT_WIDGET_CONFIGS.reduce<Record<InsightWidgetId, InsightWidgetConfig>>(
      (accumulator, widget) => {
        accumulator[widget.id] = widget;
        return accumulator;
      },
      {
        bollinger: INSIGHT_WIDGET_CONFIGS[0],
        levels: INSIGHT_WIDGET_CONFIGS[1],
        orderbook: INSIGHT_WIDGET_CONFIGS[2],
        signals: INSIGHT_WIDGET_CONFIGS[3],
      }
    );
  }, []);

  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 160,
        tolerance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    candlesRef.current = candles;
  }, [candles]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(
        INSIGHT_WIDGET_ORDER_STORAGE_KEY,
        JSON.stringify(insightWidgetOrder)
      );
    } catch {
      return;
    }
  }, [insightWidgetOrder]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(
        INSIGHT_LAYOUT_LOCK_STORAGE_KEY,
        insightLayoutLocked ? '1' : '0'
      );
    } catch {
      return;
    }
  }, [insightLayoutLocked]);

  useEffect(() => {
    if (!chartContainerRef.current) {
      return;
    }

    const container = chartContainerRef.current;

    setCandles([]);
    setSignals([]);
    setCurrentPrice(null);
    setLatestBand(null);
    setSupportResistanceLevels([]);
    setOrderBook({ bids: [], asks: [] });
    candlesRef.current = [];
    setHoverCandle(null);
    lastHoverKeyRef.current = null;

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

    if (!chart) {
      chartRef.current = null;
      setChartReady(false);
      return;
    }

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

    const applySnapshot = (snapshot: MarketSnapshot) => {
      if (!mounted) {
        return;
      }

      chart.applyNewData(snapshot.candles);
      candlesRef.current = snapshot.candles;
      setCandles(snapshot.candles);
      setCurrentPrice(snapshot.currentPrice);
      setLatestBand(snapshot.latestBand);
      setSupportResistanceLevels(snapshot.supportResistanceLevels);
      setOrderBook(snapshot.orderBook);
      setSignals(snapshot.signals);
    };

    const buildMarketWsUrl = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}${MARKET_WS_ENDPOINT}`;
    };

    const subscribeCommand: MarketClientCommand = {
      type: 'subscribe',
      symbol: selectedSymbol,
      interval: selectedInterval,
    };

    const unsubscribeCommand: MarketClientCommand = {
      type: 'unsubscribe',
      symbol: selectedSymbol,
      interval: selectedInterval,
    };

    const connectMarketStream = () => {
      const socket = new WebSocket(buildMarketWsUrl());
      marketWsRef.current = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify(subscribeCommand));
      };

      socket.onmessage = (event) => {
        let message: MarketServerEvent;

        try {
          message = JSON.parse(event.data) as MarketServerEvent;
        } catch {
          return;
        }

        if (message.type === 'error') {
          console.warn('Market service error:', message.payload.message);
          return;
        }

        if (message.type === 'depth_update') {
          if (message.symbol !== selectedSymbol) {
            return;
          }

          setOrderBook(message.payload.orderBook);
          return;
        }

        if (message.symbol !== selectedSymbol || message.interval !== selectedInterval) {
          return;
        }

        if (message.type === 'snapshot') {
          applySnapshot(message.payload);
          return;
        }

        chartRef.current?.updateData(message.payload.candle);
        setCandles((previous) => {
          const next = upsertCandle(previous, message.payload.candle, historyLimit);
          candlesRef.current = next;
          return next;
        });
        setCurrentPrice(message.payload.currentPrice);
        setLatestBand(message.payload.latestBand);
        setSupportResistanceLevels(message.payload.supportResistanceLevels);
        setSignals(message.payload.signals);
      };

      return () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(unsubscribeCommand));
        }

        socket.close();
        if (marketWsRef.current === socket) {
          marketWsRef.current = null;
        }
      };
    };

    const disconnectMarketStream = connectMarketStream();

    const loadInitialSnapshot = async () => {
      try {
        const response = await fetch(
          `${MARKET_SNAPSHOT_ENDPOINT}?symbol=${selectedSymbol}&interval=${selectedInterval}`
        );

        if (!response.ok) {
          throw new Error(`Market server returned ${response.status}`);
        }

        const snapshot = (await response.json()) as MarketSnapshot;
        applySnapshot(snapshot);
      } catch (error) {
        console.error('Failed to load market snapshot', error);
      }
    };

    void loadInitialSnapshot();

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

      disconnectMarketStream();

      if (chartContainerRef.current) {
        dispose(chartContainerRef.current);
      }

      chartRef.current = null;
      volumePaneIdRef.current = null;
      lastHoverKeyRef.current = null;
      setChartReady(false);
      setHoverCandle(null);
    };
  }, [historyLimit, selectedInterval, selectedSymbol]);

  useEffect(() => {
    if (!chartReady || !chartRef.current) {
      return;
    }

    const chart = chartRef.current;
    chart.removeOverlay({ groupId: SUPPORT_RESISTANCE_GROUP });

    if (!showSupportResistanceLines) {
      return;
    }

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
            color: level.type === 'support' ? SUPPORT_LINE_COLOR : RESISTANCE_LINE_COLOR,
            size: 1,
            style: LineType.Solid,
            dashedValue: [],
            smooth: false,
          },
        },
      }))
    );
  }, [candles, chartReady, showSupportResistanceLines, supportResistanceLevels]);

  const handleInsightWidgetDragEnd = (event: DragEndEvent) => {
    if (insightLayoutLocked) {
      return;
    }

    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    setInsightWidgetOrder((previousOrder) => {
      const activeId = active.id as InsightWidgetId;
      const overId = over.id as InsightWidgetId;
      const oldIndex = previousOrder.indexOf(activeId);
      const nextIndex = previousOrder.indexOf(overId);

      if (oldIndex < 0 || nextIndex < 0) {
        return previousOrder;
      }

      return arrayMove(previousOrder, oldIndex, nextIndex);
    });
  };

  const handleInsightLayoutReset = () => {
    setInsightWidgetOrder([...DEFAULT_INSIGHT_WIDGET_ORDER]);
  };

  const renderInsightWidget = (widgetId: InsightWidgetId) => {
    const widgetConfig = insightWidgetConfigMap[widgetId];
    if (!widgetConfig) {
      return null;
    }

    if (widgetId === 'bollinger') {
      return (
        <SortableInsightCard
          key={widgetConfig.id}
          id={widgetConfig.id}
          title={widgetConfig.title}
          cardClassName={widgetConfig.cardClassName}
          locked={insightLayoutLocked}
        >
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
        </SortableInsightCard>
      );
    }

    if (widgetId === 'levels') {
      return (
        <SortableInsightCard
          key={widgetConfig.id}
          id={widgetConfig.id}
          title={widgetConfig.title}
          cardClassName={widgetConfig.cardClassName}
          locked={insightLayoutLocked}
        >
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
        </SortableInsightCard>
      );
    }

    if (widgetId === 'orderbook') {
      return (
        <SortableInsightCard
          key={widgetConfig.id}
          id={widgetConfig.id}
          title={widgetConfig.title}
          cardClassName={widgetConfig.cardClassName}
          locked={insightLayoutLocked}
        >
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
        </SortableInsightCard>
      );
    }

    return (
      <SortableInsightCard
        key={widgetConfig.id}
        id={widgetConfig.id}
        title={widgetConfig.title}
        cardClassName={widgetConfig.cardClassName}
        locked={insightLayoutLocked}
      >
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
      </SortableInsightCard>
    );
  };

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
          <button
            type="button"
            className="sr-toggle"
            data-visible={showSupportResistanceLines ? 'true' : 'false'}
            onClick={() => setShowSupportResistanceLines((previous) => !previous)}
          >
            {showSupportResistanceLines ? '隐藏结构线' : '显示结构线'}
          </button>
          <button
            type="button"
            className="layout-lock-toggle"
            data-locked={insightLayoutLocked ? 'true' : 'false'}
            onClick={() => setInsightLayoutLocked((previous) => !previous)}
          >
            {insightLayoutLocked ? '解锁布局' : '锁定布局'}
          </button>
          <button type="button" className="layout-reset" onClick={handleInsightLayoutReset}>
            重置布局
          </button>
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
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleInsightWidgetDragEnd}
          >
            <SortableContext items={insightWidgetOrder} strategy={verticalListSortingStrategy}>
              {insightWidgetOrder.map((widgetId) => renderInsightWidget(widgetId))}
            </SortableContext>
          </DndContext>
        </aside>
      </section>
    </div>
  );
}
