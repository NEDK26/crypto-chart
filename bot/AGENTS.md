# AGENTS.md - bot/

Bot-specific guidance for coding agents working under `bot/`.

Scope note:
- This file applies to `bot/**`.
- It supplements root `AGENTS.md`; this file wins on conflicts.

## Commands (run in `bot/`)

```bash
npm install
npm run dev
npm run dev:market
npm run build
npm start
npm run start:market
npm run lint
npm run lint:fix
npm run test
npm run test:watch
npm run test:coverage
```

## Commands from repo root

```bash
npm --prefix bot run build
npm --prefix bot run lint
npm --prefix bot run test
npm --prefix bot run test:coverage
npm --prefix bot run dev:market
```

## Run a single test (important)

From `bot/`:
```bash
npm run test -- src/strategy/emaCrossover.test.ts
npm run test -- -t "golden cross"
npm run test:watch -- src/strategy/emaCrossover.test.ts
```

From repo root:
```bash
npm --prefix bot run test -- src/strategy/emaCrossover.test.ts
npm --prefix bot run test -- -t "golden cross"
```

## Bot architecture

```text
bot/
|- src/config/      # env + runtime config (Zod)
|- src/data/        # Binance API + WebSocket + domain types
|- src/strategy/    # strategy logic
|- src/execution/   # order execution
|- src/risk/        # risk controls
|- src/monitor/     # logging
|- src/index.ts     # app entrypoint
`- vitest.config.ts
```

## Coding conventions

### Language and imports
- TypeScript strict mode is required.
- Use ES modules.
- Keep `.js` suffix in local TS imports (runtime ESM requirement).
- Prefer `import type` for type-only imports.

### Formatting and lint
- Follow `bot/.prettierrc`: 2 spaces, semicolons, single quotes, width 100.
- Keep files and symbols readable and consistent with existing style.
- Remove dead imports/variables unless intentionally prefixed with `_`.

### Naming
- Files: camelCase (`binanceApi.ts`, `orderExecutor.ts`).
- Classes/interfaces/types: PascalCase.
- Functions/variables: camelCase.
- Constants: UPPER_SNAKE_CASE.

### Patterns
- Use classes for long-lived services (API, websocket, risk, execution).
- Keep external side effects in dedicated modules (`data/`, `execution/`).
- Validate config via Zod in `src/config/index.ts`.
- Keep domain types centralized in `src/data/types.ts`.

### Error handling and logging
- Wrap external I/O in `try/catch`.
- Log structured context with `pino` logger.
- Prefer patterns like `logger.error({ error, ...context }, 'message')`.
- Re-throw when upstream caller should decide recovery.

## Testing guidance

- Test framework: Vitest (`node` environment).
- Test location/pattern: `src/**/*.test.ts`.
- Mock Binance REST/WebSocket dependencies for deterministic tests.
- Prefer focused unit tests around strategy, risk, and execution.
- For bug fixes, add or update a targeted test when practical.

## Security and config hygiene

- Never commit `.env` or real API credentials.
- Keep `.env.example` updated with required keys.
- Sanitize secrets when logging config objects.
