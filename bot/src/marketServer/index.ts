import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config as loadEnv } from 'dotenv';
import { WebSocket, WebSocketServer } from 'ws';
import { loadMarketServerConfig } from '../config/marketServerConfig.js';
import { marketLogger } from './logger.js';
import {
  getChannelKey,
  isSupportedInterval,
  splitChannelKey,
} from './intervalConfig.js';
import {
  MarketDataService,
  type DepthUpdateEvent,
  type KlineUpdateEvent,
  type SnapshotUpdateEvent,
} from './marketDataService.js';
import type { KlineInterval, MarketClientCommand, MarketServerEvent } from './types.js';

loadEnv();

const config = loadMarketServerConfig();
const marketDataService = new MarketDataService({
  binanceBaseUrls: config.binanceBaseUrls,
  restTimeoutMs: config.binanceTimeoutMs,
});

const server = createServer((request, response) => {
  void handleHttpRequest(request, response);
});

const wsServer = new WebSocketServer({ noServer: true });

interface ClientContext {
  subscriptions: Set<string>;
}

const clients = new Map<WebSocket, ClientContext>();

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  setCorsHeaders(response);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function normalizeSymbol(rawValue: string | null): string | null {
  if (!rawValue) {
    return null;
  }

  const normalized = rawValue.trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function sendWsEvent(client: WebSocket, event: MarketServerEvent): void {
  if (client.readyState !== WebSocket.OPEN) {
    return;
  }

  client.send(JSON.stringify(event));
}

function cleanupClient(client: WebSocket): void {
  const context = clients.get(client);
  if (!context) {
    return;
  }

  for (const channelKey of context.subscriptions) {
    const parsed = splitChannelKey(channelKey);
    if (!parsed) {
      continue;
    }

    const [symbol, interval] = parsed;
    marketDataService.unsubscribeChannel(symbol, interval);
  }

  clients.delete(client);
}

function isClientSubscribedToSymbol(context: ClientContext, symbol: string): boolean {
  for (const subscription of context.subscriptions) {
    const parsed = splitChannelKey(subscription);
    if (!parsed) {
      continue;
    }

    if (parsed[0] === symbol) {
      return true;
    }
  }

  return false;
}

async function handleWsCommand(client: WebSocket, rawMessage: string): Promise<void> {
  let command: MarketClientCommand;

  try {
    command = JSON.parse(rawMessage) as MarketClientCommand;
  } catch {
    sendWsEvent(client, {
      type: 'error',
      payload: {
        message: 'Invalid JSON payload',
      },
    });
    return;
  }

  const symbol = normalizeSymbol(command.symbol);
  const intervalValue = command.interval;

  if (!symbol || !intervalValue || !isSupportedInterval(intervalValue)) {
    sendWsEvent(client, {
      type: 'error',
      payload: {
        message: 'Invalid subscribe params: symbol or interval',
      },
    });
    return;
  }

  const interval = intervalValue as KlineInterval;
  const channelKey = getChannelKey(symbol, interval);
  const context = clients.get(client);

  if (!context) {
    return;
  }

  if (command.type === 'subscribe') {
    if (context.subscriptions.has(channelKey)) {
      return;
    }

    try {
      const snapshot = await marketDataService.subscribeChannel(symbol, interval);
      context.subscriptions.add(channelKey);
      sendWsEvent(client, {
        type: 'snapshot',
        symbol,
        interval,
        payload: snapshot,
      });
    } catch (error) {
      marketLogger.error({ error, symbol, interval }, 'WS subscribe failed');
      sendWsEvent(client, {
        type: 'error',
        payload: {
          message: 'Failed to subscribe channel',
        },
      });
    }

    return;
  }

  if (command.type === 'unsubscribe') {
    if (!context.subscriptions.has(channelKey)) {
      return;
    }

    context.subscriptions.delete(channelKey);
    marketDataService.unsubscribeChannel(symbol, interval);
    return;
  }
}

function broadcastKlineUpdate(event: KlineUpdateEvent): void {
  const channelKey = getChannelKey(event.symbol, event.interval);

  for (const [client, context] of clients.entries()) {
    if (!context.subscriptions.has(channelKey)) {
      continue;
    }

    sendWsEvent(client, {
      type: 'kline_update',
      symbol: event.symbol,
      interval: event.interval,
      payload: event.payload,
    });
  }
}

function broadcastDepthUpdate(event: DepthUpdateEvent): void {
  for (const [client, context] of clients.entries()) {
    if (!isClientSubscribedToSymbol(context, event.symbol)) {
      continue;
    }

    sendWsEvent(client, {
      type: 'depth_update',
      symbol: event.symbol,
      payload: event.payload,
    });
  }
}

function broadcastSnapshotUpdate(event: SnapshotUpdateEvent): void {
  const channelKey = getChannelKey(event.symbol, event.interval);

  for (const [client, context] of clients.entries()) {
    if (!context.subscriptions.has(channelKey)) {
      continue;
    }

    sendWsEvent(client, {
      type: 'snapshot',
      symbol: event.symbol,
      interval: event.interval,
      payload: event.payload,
    });
  }
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!request.url) {
    writeJson(response, 400, { error: 'Missing request url' });
    return;
  }

  if (request.method === 'OPTIONS') {
    setCorsHeaders(response);
    response.statusCode = 204;
    response.end();
    return;
  }

  const host = request.headers.host ?? 'localhost';
  const url = new URL(request.url, `http://${host}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    writeJson(response, 200, {
      ok: true,
      service: 'market-server',
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/market/snapshot') {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    const interval = url.searchParams.get('interval');

    if (!symbol || !interval || !isSupportedInterval(interval)) {
      writeJson(response, 400, {
        error: 'Query params symbol and interval are required',
      });
      return;
    }

    try {
      const snapshot = await marketDataService.getSnapshot(symbol, interval);
      writeJson(response, 200, snapshot);
    } catch (error) {
      marketLogger.error({ error, symbol, interval }, 'HTTP snapshot request failed');
      writeJson(response, 502, {
        error: 'Failed to fetch market snapshot',
      });
    }

    return;
  }

  writeJson(response, 404, {
    error: 'Not found',
  });
}

wsServer.on('connection', (client) => {
  clients.set(client, {
    subscriptions: new Set<string>(),
  });

  client.on('message', (raw) => {
    void handleWsCommand(client, raw.toString());
  });

  client.on('close', () => {
    cleanupClient(client);
  });

  client.on('error', (error) => {
    marketLogger.warn({ error }, 'Market server websocket client error');
    cleanupClient(client);
  });
});

server.on('upgrade', (request, socket, head) => {
  try {
    const host = request.headers.host ?? 'localhost';
    const url = new URL(request.url ?? '/', `http://${host}`);

    if (url.pathname !== '/ws/market') {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (client) => {
      wsServer.emit('connection', client, request);
    });
  } catch {
    socket.destroy();
  }
});

marketDataService.onKlineUpdate(broadcastKlineUpdate);
marketDataService.onDepthUpdate(broadcastDepthUpdate);
marketDataService.onSnapshotUpdate(broadcastSnapshotUpdate);

server.listen(config.port, config.host, () => {
  marketLogger.info(
    {
      host: config.host,
      port: config.port,
      timeoutMs: config.binanceTimeoutMs,
      baseUrls: config.binanceBaseUrls,
    },
    'Market server started'
  );
});

function shutdown(signal: string): void {
  marketLogger.info({ signal }, 'Market server shutting down');

  for (const client of wsServer.clients) {
    client.close();
  }

  wsServer.close();
  marketDataService.close();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
