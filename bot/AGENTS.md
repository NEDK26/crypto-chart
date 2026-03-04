# AGENTS.md - Crypto Trading Bot

## Project Overview

Quantitative trading bot for cryptocurrency using Binance API. Built with TypeScript, Node.js.

## Commands

```bash
# Install dependencies
npm install

# Development (with hot reload)
npm run dev

# Build for production
npm run build

# Start production
npm start

# Lint
npm run lint

# Fix lint errors
npm run lint:fix

# Run tests
npm test

# Watch tests
npm test:watch

# Test coverage
npm test:coverage
```

## Code Style Guidelines

### Language
- TypeScript (strict mode enabled)
- ES Modules (`.js` extension in imports)

### Imports
```typescript
import { something } from './module.js';
import { logger } from '../monitor/logger.js';
```

### Naming Conventions
- **Files**: camelCase (e.g., `binanceApi.ts`, `orderExecutor.ts`)
- **Classes**: PascalCase (e.g., `BinanceApiClient`, `RiskManager`)
- **Functions/variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- **Interfaces**: PascalCase (e.g., `Kline`, `Order`)

### Components
- Use classes for services (API clients, managers)
- Use functions for strategies
- Always use async/await for async operations

### Error Handling
- Use try/catch for API calls
- Log errors with context using logger
- Throw errors for fatal failures

### TypeScript Rules
- Always define return types for functions
- Use interfaces for data structures
- Enable strict mode - no `any` unless absolutely necessary

### Configuration
- Use `zod` for environment variable validation
- Never hardcode secrets
- Use `.env.example` for template

### Testing
- Unit tests in `*.test.ts` files
- Use Vitest
- Mock external dependencies (API, WebSocket)

## Project Structure

```
bot/
├── src/
│   ├── config/         # Configuration management
│   ├── data/           # Data layer (API, WebSocket, types)
│   ├── strategy/      # Trading strategies
│   ├── execution/     # Order execution
│   ├── risk/           # Risk management
│   ├── monitor/       # Logging
│   └── index.ts       # Entry point
├── .env.example        # Environment template
├── tsconfig.json       # TypeScript config
├── vitest.config.ts    # Test config
└── package.json
```

## Key Patterns

### API Client
```typescript
export class BinanceApiClient {
  async getKlines(...): Promise<Kline[]> { ... }
}
```

### Strategy
```typescript
export class EmaCrossoverStrategy {
  addKline(kline: Kline): void { ... }
  analyze(): TradeSignal { ... }
}
```

### Risk Manager
```typescript
checkBeforeTrade(signal: TradeSignal, currentPosition: boolean): RiskCheckResult
```

## Dependencies

- **ws**: WebSocket client
- **axios**: HTTP requests
- **technicalindicators**: Technical analysis
- **pino**: Logging
- **dotenv**: Environment variables
- **zod**: Schema validation
- **pm2**: Process manager (run separately)
