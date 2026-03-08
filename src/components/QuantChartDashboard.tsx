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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ActionType,
  LineType,
  PolygonType,
  dispose,
  init,
  registerOverlay,
  type Chart,
  type Crosshair,
  type Point,
} from 'klinecharts';
import type {
  BollingerBandPoint,
  Candle,
  LevelType,
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
const SUPPORT_ZONE_OVERLAY_NAME = 'supportResistanceZoneBand';
const MARKET_SNAPSHOT_ENDPOINT = '/api/market/snapshot';
const MARKET_WS_ENDPOINT = '/ws/market';
const SUPPORT_COLOR_RGB = '103, 236, 182';
const RESISTANCE_COLOR_RGB = '255, 149, 170';

const LEVEL_LINE_SIZE_BY_TIER = {
  strong: 2,
  mid: 1.5,
  weak: 1,
} as const;

const LEVEL_ZONE_OPACITY_BY_TIER = {
  strong: 0.16,
  mid: 0.11,
  weak: 0.07,
} as const;

const HIGHER_INTERVAL_MAP: Partial<Record<KlineInterval, KlineInterval>> = {
  '1m': '5m',
  '5m': '1h',
  '1h': '4h',
  '4h': '1d',
};

let supportZoneOverlayRegistered = false;

function toRgba(rgb: string, alpha: number): string {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb}, ${normalizedAlpha})`;
}

function getLevelColorRgb(type: LevelType): string {
  return type === 'support' ? SUPPORT_COLOR_RGB : RESISTANCE_COLOR_RGB;
}

function ensureSupportZoneOverlayRegistered(): void {
  if (supportZoneOverlayRegistered) {
    return;
  }

  registerOverlay({
    name: SUPPORT_ZONE_OVERLAY_NAME,
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      if (coordinates.length < 2) {
        return [];
      }

      const first = coordinates[0];
      const second = coordinates[1];
      const startX = Math.min(first.x, second.x);
      const topY = Math.min(first.y, second.y);
      const bottomY = Math.max(first.y, second.y);
      const zoneHeight = Math.max(bottomY - topY, 1);
      const centerY = topY + zoneHeight / 2;
      const zoneWidth = Math.max(bounding.width - startX, 1);
      const extendData =
        typeof overlay.extendData === 'object' && overlay.extendData !== null
          ? (overlay.extendData as { label?: string; showLabel?: boolean })
          : null;
      const text =
        extendData && typeof extendData.label === 'string' ? String(extendData.label) : '';
      const showLabel = Boolean(extendData?.showLabel) && text.length > 0;

      const figures: Array<{
        type: 'rect' | 'line' | 'text';
        attrs: Record<string, unknown>;
        ignoreEvent?: boolean;
      }> = [
        {
          type: 'rect',
          attrs: {
            x: startX,
            y: topY,
            width: zoneWidth,
            height: zoneHeight,
          },
        },
        {
          type: 'line',
          attrs: {
            coordinates: [
              { x: startX, y: centerY },
              { x: bounding.width, y: centerY },
            ],
          },
        },
      ];

      if (showLabel) {
        figures.push({
          type: 'text',
          attrs: {
            x: Math.max(6, bounding.width - 8),
            y: centerY,
            text,
            align: 'right',
            baseline: 'middle',
          },
          ignoreEvent: true,
        });
      }

      return figures;
    },
  });

  supportZoneOverlayRegistered = true;
}

type KlineInterval = '1m' | '5m' | '1h' | '4h' | '1d';
type MarketSymbol = 'BTCUSDC' | 'ETHUSDC';
type InsightWidgetId = 'levels' | 'orderbook' | 'signals';

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
    maxLevelsPerType: 3,
    proximityThresholdRatio: 0.0009,
  },
  '5m': {
    historyLimit: 1000,
    pivotWindow: 3,
    clusterTolerance: 0.0028,
    maxLevelsPerType: 3,
    proximityThresholdRatio: 0.0011,
  },
  '1h': {
    historyLimit: 800,
    pivotWindow: 3,
    clusterTolerance: 0.003,
    maxLevelsPerType: 3,
    proximityThresholdRatio: 0.0016,
  },
  '4h': {
    historyLimit: 700,
    pivotWindow: 3,
    clusterTolerance: 0.0042,
    maxLevelsPerType: 3,
    proximityThresholdRatio: 0.0022,
  },
  '1d': {
    historyLimit: 500,
    pivotWindow: 2,
    clusterTolerance: 0.006,
    maxLevelsPerType: 3,
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

interface BinanceKlineStreamPayload {
  E?: number;
  k?: {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
  };
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

function resolveLevelDistancePct(level: PriceLevel, referencePrice: number | null): number {
  if (referencePrice !== null && Number.isFinite(referencePrice) && referencePrice > 0) {
    return ((level.price - referencePrice) / referencePrice) * 100;
  }

  return typeof level.distancePct === 'number' ? level.distancePct : 0;
}

function buildLevelTagText(
  level: PriceLevel,
  referencePrice: number | null,
  sourceIntervalLabel: string | null
): string {
  const sidePrefix = level.type === 'support' ? 'S' : 'R';
  const distancePct = resolveLevelDistancePct(level, referencePrice);
  const rankText = `${sidePrefix}${level.rank ?? ''}`;
  const intervalSuffix = sourceIntervalLabel ? `(${sourceIntervalLabel})` : '';
  const flipSuffix =
    level.isFlipped && level.sourceType
      ? ` ${level.sourceType === 'support' ? 'S→R' : 'R→S'}`
      : '';

  return `${rankText}${intervalSuffix}${flipSuffix} ${level.price.toFixed(2)} ${formatSignedDelta(
    distancePct
  )} x${level.touches}`;
}

function dedupeLevelsByPriceGap(levels: PriceLevel[], minGapRatio: number): PriceLevel[] {
  const picked: PriceLevel[] = [];

  for (const level of levels) {
    const isFarEnough = picked.every((existing) => {
      const denominator = Math.max(existing.price, level.price, 1);
      return Math.abs(existing.price - level.price) / denominator >= minGapRatio;
    });

    if (isFarEnough) {
      picked.push(level);
    }
  }

  return picked;
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
  const fallbackKlineWsRef = useRef<WebSocket | null>(null);

  const [chartReady, setChartReady] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [supportResistanceLevels, setSupportResistanceLevels] = useState<PriceLevel[]>([]);
  const [higherIntervalLevels, setHigherIntervalLevels] = useState<PriceLevel[]>([]);
  const [orderBook, setOrderBook] = useState<OrderBookSnapshot>({ bids: [], asks: [] });
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [hoverCandle, setHoverCandle] = useState<HoverCandleInfo | null>(null);
  const [hoveredLevelKey, setHoveredLevelKey] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<MarketSymbol>('BTCUSDC');
  const [selectedInterval, setSelectedInterval] = useState<KlineInterval>('1m');
  const [showSupportResistanceLines, setShowSupportResistanceLines] = useState(true);
  const [showHigherIntervalOverlay, setShowHigherIntervalOverlay] = useState(true);
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
  const higherInterval = HIGHER_INTERVAL_MAP[selectedInterval] ?? null;
  const higherIntervalLabel = higherInterval
    ? (INTERVAL_OPTIONS.find((option) => option.value === higherInterval)?.label ?? higherInterval)
    : null;

  const insightWidgetConfigMap = useMemo(() => {
    return INSIGHT_WIDGET_CONFIGS.reduce<Record<InsightWidgetId, InsightWidgetConfig>>(
      (accumulator, widget) => {
        accumulator[widget.id] = widget;
        return accumulator;
      },
      {
        levels: INSIGHT_WIDGET_CONFIGS[0],
        orderbook: INSIGHT_WIDGET_CONFIGS[1],
        signals: INSIGHT_WIDGET_CONFIGS[2],
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

    ensureSupportZoneOverlayRegistered();

    const container = chartContainerRef.current;

    setCandles([]);
    setSignals([]);
    setCurrentPrice(null);
    setSupportResistanceLevels([]);
    setHigherIntervalLevels([]);
    setOrderBook({ bids: [], asks: [] });
    setHoveredLevelKey(null);
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
      setHoveredLevelKey(null);
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
      setSupportResistanceLevels(snapshot.supportResistanceLevels);
      setOrderBook(snapshot.orderBook);
      setSignals(snapshot.signals);
    };

    const buildMarketWsUrl = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}${MARKET_WS_ENDPOINT}`;
    };

    const buildFallbackKlineUrl = () => {
      return `wss://data-stream.binance.vision/ws/${selectedSymbol.toLowerCase()}@kline_${selectedInterval}`;
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

    let fallbackStartTimer: number | null = null;
    let fallbackStarted = false;

    const stopFallbackKlineStream = () => {
      if (fallbackStartTimer !== null) {
        window.clearTimeout(fallbackStartTimer);
        fallbackStartTimer = null;
      }

      const socket = fallbackKlineWsRef.current;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }
      fallbackKlineWsRef.current = null;
      fallbackStarted = false;
    };

    const startFallbackKlineStream = () => {
      if (fallbackStarted || !mounted) {
        return;
      }

      fallbackStarted = true;
      const socket = new WebSocket(buildFallbackKlineUrl());
      fallbackKlineWsRef.current = socket;

      socket.onmessage = (event) => {
        let payload: BinanceKlineStreamPayload;

        try {
          payload = JSON.parse(event.data) as BinanceKlineStreamPayload;
        } catch {
          return;
        }

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

        chartRef.current?.updateData(candle);
        setCandles((previous) => {
          const next = upsertCandle(previous, candle, historyLimit);
          candlesRef.current = next;
          return next;
        });
        setCurrentPrice(candle.close);
      };

      socket.onclose = () => {
        if (fallbackKlineWsRef.current === socket) {
          fallbackKlineWsRef.current = null;
        }
      };
    };

    fallbackStartTimer = window.setTimeout(() => {
      startFallbackKlineStream();
    }, 4000);

    const connectMarketStream = () => {
      let reconnectTimer: number | null = null;
      let reconnectAttempt = 0;
      let closedByEffectCleanup = false;

      const scheduleReconnect = () => {
        if (!mounted || closedByEffectCleanup || reconnectTimer !== null) {
          return;
        }

        const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempt, 4), 8000);
        reconnectAttempt += 1;

        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          openSocket();
        }, delay);
      };

      const openSocket = () => {
        if (!mounted || closedByEffectCleanup) {
          return;
        }

        const socket = new WebSocket(buildMarketWsUrl());
        marketWsRef.current = socket;

        socket.onopen = () => {
          if (marketWsRef.current !== socket) {
            return;
          }

          reconnectAttempt = 0;
          socket.send(JSON.stringify(subscribeCommand));
        };

        socket.onmessage = (event) => {
          if (marketWsRef.current !== socket) {
            return;
          }

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

          if (message.type !== 'snapshot') {
            if (fallbackStartTimer !== null) {
              window.clearTimeout(fallbackStartTimer);
              fallbackStartTimer = null;
            }

            if (fallbackKlineWsRef.current) {
              stopFallbackKlineStream();
            }
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
          setSupportResistanceLevels(message.payload.supportResistanceLevels);
          setSignals(message.payload.signals);
        };

        socket.onerror = () => {
          if (marketWsRef.current !== socket) {
            return;
          }

          socket.close();
        };

        socket.onclose = () => {
          if (marketWsRef.current === socket) {
            marketWsRef.current = null;
          }

          if (closedByEffectCleanup || !mounted) {
            return;
          }

          scheduleReconnect();
        };
      };

      openSocket();

      return () => {
        closedByEffectCleanup = true;

        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        stopFallbackKlineStream();

        const activeSocket = marketWsRef.current;
        if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
          activeSocket.send(JSON.stringify(unsubscribeCommand));
        }

        if (activeSocket && activeSocket.readyState !== WebSocket.CLOSED) {
          activeSocket.close();
        }

        if (marketWsRef.current === activeSocket) {
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
    if (!higherInterval) {
      setHigherIntervalLevels([]);
      return;
    }

    let cancelled = false;
    let latestRequestId = 0;

    const loadHigherIntervalLevels = async () => {
      const requestId = ++latestRequestId;

      try {
        const response = await fetch(
          `${MARKET_SNAPSHOT_ENDPOINT}?symbol=${selectedSymbol}&interval=${higherInterval}`
        );

        if (!response.ok) {
          throw new Error(`Market server returned ${response.status}`);
        }

        const snapshot = (await response.json()) as MarketSnapshot;
        if (!cancelled && requestId === latestRequestId) {
          setHigherIntervalLevels(snapshot.supportResistanceLevels);
        }
      } catch (error) {
        if (!cancelled && requestId === latestRequestId) {
          setHigherIntervalLevels([]);
        }

        if (!cancelled) {
          console.warn('Failed to load higher interval levels', error);
        }
      }
    };

    void loadHigherIntervalLevels();
    const timer = window.setInterval(() => {
      void loadHigherIntervalLevels();
    }, 45_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [higherInterval, selectedSymbol]);

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

    const primaryLevels = dedupeLevelsByPriceGap(supportResistanceLevels, 0.0008);
    const overlayLevels =
      higherInterval && showHigherIntervalOverlay
        ? dedupeLevelsByPriceGap(higherIntervalLevels, 0.0012)
        : [];

    if (primaryLevels.length === 0 && overlayLevels.length === 0) {
      return;
    }

    const buildZoneOverlay = (level: PriceLevel, isHigherInterval: boolean) => {
      const hoverKey = `${isHigherInterval ? 'higher' : 'primary'}:${level.id}`;
      const rgb = getLevelColorRgb(level.type);
      const dynamicDistancePct = resolveLevelDistancePct(level, livePrice);
      const tier = level.tier ?? 'mid';
      const isNear = Boolean(level.isNear) || Math.abs(dynamicDistancePct) <= 0.25;
      const zoneLow =
        typeof level.zoneLow === 'number' && Number.isFinite(level.zoneLow)
          ? level.zoneLow
          : level.price;
      const zoneHigh =
        typeof level.zoneHigh === 'number' && Number.isFinite(level.zoneHigh)
          ? level.zoneHigh
          : level.price;

      const baseLineSize = LEVEL_LINE_SIZE_BY_TIER[tier];
      const lineSize = baseLineSize + (isNear ? 0.45 : 0);
      const zoneOpacity =
        LEVEL_ZONE_OPACITY_BY_TIER[tier] * (isHigherInterval ? 0.62 : 1) *
        (isNear ? 1.08 : 1);
      const lineOpacity = (isHigherInterval ? 0.58 : 0.92) + (isNear ? 0.06 : 0);
      const isFlipped = Boolean(level.isFlipped);

      return {
        name: SUPPORT_ZONE_OVERLAY_NAME,
        groupId: SUPPORT_RESISTANCE_GROUP,
        lock: true,
        zLevel: isHigherInterval ? 1 : 3,
        points: [
          { timestamp: level.sourceTimestamp ?? lastCandle.timestamp, value: zoneLow },
          { timestamp: lastCandle.timestamp, value: zoneHigh },
        ],
        extendData: {
          label: buildLevelTagText(
            level,
            livePrice,
            isHigherInterval && higherIntervalLabel ? higherIntervalLabel : null
          ),
          showLabel: hoveredLevelKey === hoverKey,
        },
        onMouseEnter: () => {
          setHoveredLevelKey(hoverKey);
          return true;
        },
        onMouseLeave: () => {
          setHoveredLevelKey((current) => (current === hoverKey ? null : current));
          return true;
        },
        styles: {
          rect: {
            style: PolygonType.Fill,
            color: toRgba(rgb, Math.min(zoneOpacity, 0.2)),
            borderColor: 'transparent',
            borderSize: 0,
            borderStyle: LineType.Solid,
            borderDashedValue: [],
            borderRadius: 0,
          },
          line: {
            color: toRgba(rgb, Math.min(lineOpacity, 0.96)),
            size: lineSize,
            style: isHigherInterval || isFlipped ? LineType.Dashed : LineType.Solid,
            dashedValue: isHigherInterval || isFlipped ? [6, 4] : [],
            smooth: false,
          },
          text: {
            style: PolygonType.Fill,
            color: toRgba(rgb, isHigherInterval ? 0.9 : 0.96),
            size: isNear ? 11 : 10,
            family: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
            weight: isNear ? '700' : '600',
            borderStyle: LineType.Solid,
            borderDashedValue: [],
            borderSize: 1,
            borderColor: toRgba(rgb, isHigherInterval ? 0.32 : 0.46),
            borderRadius: 4,
            backgroundColor: 'rgba(7, 17, 27, 0.78)',
            paddingLeft: 5,
            paddingRight: 5,
            paddingTop: 2,
            paddingBottom: 2,
          },
        },
      };
    };

    const overlays = [
      ...overlayLevels.map((level) => buildZoneOverlay(level, true)),
      ...primaryLevels.map((level) => buildZoneOverlay(level, false)),
    ];

    chart.createOverlay(overlays);
  }, [
    candles,
    chartReady,
    higherInterval,
    higherIntervalLabel,
    higherIntervalLevels,
    hoveredLevelKey,
    livePrice,
    showHigherIntervalOverlay,
    showSupportResistanceLines,
    supportResistanceLevels,
  ]);

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
              supportResistanceLevels.map((level: PriceLevel, index) => {
                const sidePrefix = level.type === 'support' ? 'S' : 'R';
                const tier = level.tier ?? 'mid';
                const rank = level.rank ?? index + 1;
                const tierLabel =
                  tier === 'strong' ? '强' : tier === 'mid' ? '中' : '弱';
                const distancePct = resolveLevelDistancePct(level, livePrice);
                const isNear = Boolean(level.isNear) || Math.abs(distancePct) <= 0.25;
                const flipLabel =
                  level.isFlipped && level.sourceType
                    ? level.sourceType === 'support'
                      ? 'S→R'
                      : 'R→S'
                    : null;

                return (
                  <div
                    key={level.id}
                    className={`level-item ${level.type} ${tier} ${isNear ? 'near' : ''} ${level.isFlipped ? 'flipped' : ''}`}
                  >
                    <span>{`${sidePrefix}${rank} · ${tierLabel}${flipLabel ? ` · ${flipLabel}` : ''}`}</span>
                    <strong>{formatPrice(level.price)}</strong>
                    <small>{`${formatSignedDelta(distancePct)} · x${level.touches}`}</small>
                  </div>
                );
              })
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
            onClick={() => {
              setHoveredLevelKey(null);
              setShowSupportResistanceLines((previous) => !previous);
            }}
          >
            {showSupportResistanceLines ? '隐藏结构线' : '显示结构线'}
          </button>
          {higherIntervalLabel ? (
            <button
              type="button"
              className="higher-interval-toggle"
              data-visible={showHigherIntervalOverlay ? 'true' : 'false'}
              onClick={() => setShowHigherIntervalOverlay((previous) => !previous)}
            >
              {showHigherIntervalOverlay
                ? `隐藏${higherIntervalLabel}叠加`
                : `显示${higherIntervalLabel}叠加`}
            </button>
          ) : null}
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
      </section>

      <section className="insight-grid">
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleInsightWidgetDragEnd}
        >
          <SortableContext items={insightWidgetOrder} strategy={rectSortingStrategy}>
            {insightWidgetOrder.map((widgetId) => renderInsightWidget(widgetId))}
          </SortableContext>
        </DndContext>
      </section>
    </div>
  );
}
