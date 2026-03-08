# Backend Services

这个仓库当前涉及两个后端侧进程，位置都在 `bot/` 下。

## 1. Market Server（行情服务）

- 入口：`bot/src/marketServer/index.ts`
- 启动命令：`npm --prefix bot run dev:market`
- 默认端口：`4180`
- 健康检查：`GET /health`

### 主要职责

- 为前端提供市场快照接口：`GET /api/market/snapshot`
- 为前端提供实时 WebSocket：`WS /ws/market`
- 拉取和维护 K 线缓存
- 拉取和维护盘口深度缓存
- 计算布林带、支撑阻力、信号流
- 在前端切换交易对/周期时统一提供数据，不让前端直接依赖 Binance REST

### 上游依赖

- REST：优先 `https://data-api.binance.vision`
- WebSocket：`wss://data-stream.binance.vision/ws`
- 失败时会尝试 Binance 其他 REST 域名回退

### 关键模块

- 配置：`bot/src/config/marketServerConfig.ts`
- 数据服务：`bot/src/marketServer/marketDataService.ts`
- 信号计算：`bot/src/marketServer/signalEngine.ts`
- 支撑阻力计算：`bot/src/marketServer/quant/supportResistance.ts`
- 布林带计算：`bot/src/marketServer/quant/bollinger.ts`
- 日志：`bot/src/marketServer/logger.ts`

### 前端如何使用它

- Vite 代理配置：`vite.config.js`
- 前端通过相对路径访问：
  - `/api/market/snapshot`
  - `/ws/market`

## 2. Trading Bot（交易机器人主进程）

- 入口：`bot/src/index.ts`
- 启动命令：
  - 开发：`npm --prefix bot run dev`
  - 生产：`npm --prefix bot start`

### 主要职责

- 运行交易策略
- 进行风险控制
- 调用执行模块下单
- 连接 Binance API / WebSocket 做策略交易相关处理

### 关键模块

- 配置：`bot/src/config/index.ts`
- 数据接入：`bot/src/data/`
- 策略：`bot/src/strategy/`
- 风控：`bot/src/risk/`
- 执行：`bot/src/execution/`
- 监控日志：`bot/src/monitor/`

### 注意

- 这个进程和前端页面不是强依赖关系
- 当前前端展示主要依赖的是 `Market Server`
- 如果只是看图和行情，不需要启动交易机器人主进程

## 本地开发推荐启动方式

### 只看前端行情页面

```bash
./start-dev.sh
```

会启动：

- `Market Server`
- 前端开发服务（默认 `http://localhost:6644`）

### 跑交易机器人

```bash
npm --prefix bot run dev
```

如果你同时需要前端页面和交易逻辑，可以分别再开一个终端启动。

## 端口和访问地址

- 前端：`http://localhost:6644`
- 行情服务：`http://localhost:4180`
- 健康检查：`http://localhost:4180/health`

## 当前关系总结

- 前端 <- `Market Server`
- `Market Server` <- Binance 行情接口
- `Trading Bot` <- Binance 交易/行情接口
- `Trading Bot` 和前端当前没有直接耦合

## 排查建议

### 页面没数据

先检查：

```bash
curl http://127.0.0.1:4180/health
```

如果健康检查正常，再检查快照：

```bash
curl "http://127.0.0.1:4180/api/market/snapshot?symbol=BTCUSDC&interval=1m"
```

### 页面价格不实时

- 先看 `Market Server` 是否在运行
- 再看 `bot/nohup.market.out`
- 再检查前端是否连上 `/ws/market`

## 后续如果继续扩展

未来可以继续拆成更多服务，例如：

- `execution-service`（专门负责下单）
- `strategy-service`（专门负责策略运算）
- `notification-service`（告警/推送）

但当前仓库里，真正独立可运行的后端服务就是上面这两个。
