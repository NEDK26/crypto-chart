# AGENTS.md

Guidance for coding agents operating in this repository.

This repo has two Node/TypeScript projects:
- Frontend app at repo root (Vite + React + TypeScript).
- Trading bot at `bot/` (Node + TypeScript + Vitest).

## Rule Sources (Cursor / Copilot)

Checked on 2026-03-04:
- No `.cursorrules` file found.
- No `.cursor/rules/` directory found.
- No `.github/copilot-instructions.md` file found.

If any of the above files are added later, treat them as higher-priority instructions.

## Build / Lint / Test Commands

### Frontend (run in repo root)
```bash
npm install
npm run dev
npm run dev:market
npm run build
npm run preview
npm run lint
npm run typecheck
./start-dev.sh
./start-frontend.sh
```

Frontend notes:
- There is currently no frontend test script in root `package.json`.
- Root ESLint config currently targets `**/*.{js,jsx}` only.

### Bot (run in `bot/`)
```bash
cd bot
npm install
npm run dev
npm run build
npm start
npm run lint
npm run lint:fix
npm run test
npm run test:watch
npm run test:coverage
```

### Bot commands from repo root
```bash
npm --prefix bot run build
npm --prefix bot run lint
npm --prefix bot run test
npm --prefix bot run test:coverage
npm --prefix bot run dev:market
```

### Run a single test (important)

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

## Project Structure

```text
.
|- src/                     # Frontend app source (React + TS)
|  |- components/
|  |- quant/
|  `- types/
|- bot/
|  |- src/
|  |  |- config/
|  |  |- data/
|  |  |- execution/
|  |  |- monitor/
|  |  |- risk/
|  |  `- strategy/
|  `- vitest.config.ts
|- eslint.config.js
`- bot/eslint.config.js
```

## Code Style Guidelines

### Language and modules
- Use TypeScript strict mode in both projects.
- Use ES modules.
- In `bot/`, keep `.js` suffix in local TS imports for runtime ESM compatibility.

### Formatting
- Follow existing style: 2-space indentation, semicolons, single quotes.
- In `bot/`, format according to `bot/.prettierrc`.
- Keep lines readable (`printWidth` is 100 in bot).

### Imports
- Group imports: external packages -> internal modules -> styles/assets.
- Use `import type` for type-only imports.
- Keep imports used and minimal; remove dead imports.

### Naming conventions
- React components: PascalCase (`QuantChartDashboard`).
- Classes: PascalCase (`BinanceApiClient`, `RiskManager`).
- Functions/variables: camelCase.
- Constants: UPPER_SNAKE_CASE for stable shared constants.
- Non-component file names: camelCase (`supportResistance.ts`, `orderExecutor.ts`).
- Type/interface names: PascalCase.

### Types and data modeling
- Prefer explicit interfaces/types for payloads and domain models.
- Prefer union literals for finite states (`'BUY' | 'SELL' | 'HOLD'`).
- Avoid `any`; if unavoidable, narrow quickly at boundaries.
- Keep shared domain types centralized (`src/types/market.ts`, `bot/src/data/types.ts`).

### Error handling and logging
- Wrap external I/O (HTTP, WebSocket, filesystem) in `try/catch`.
- Log with context-rich structured logs in bot (`pino`).
- Use patterns like `logger.error({ error, ...context }, 'message')`.
- Re-throw when caller controls recovery; otherwise fail gracefully.
- In frontend, avoid crashing UI on transient data errors; guard parsing and return early.

### Frontend patterns
- Prefer functional components and hooks.
- Keep expensive calculations memoized with `useMemo` when beneficial.
- Keep side effects isolated in `useEffect` with correct dependencies.
- Clean up listeners and sockets in effect cleanup functions.

### Bot patterns
- Prefer classes for long-lived services (API client, websocket client, risk manager).
- Keep side-effect integrations in dedicated modules (`data/`, `execution/`).
- Validate startup config via Zod (`bot/src/config/index.ts`).

### Testing guidance
- Bot tests belong in `bot/src/**/*.test.ts` (Vitest, node environment).
- Mock Binance REST/WebSocket dependencies to keep tests deterministic.
- Prefer focused unit tests for strategy, risk, and execution modules.
- For bug fixes, add or adjust a targeted test when practical.

### Lint and quality expectations
- Run lint before finishing substantial edits.
- For bot changes, run at least targeted tests for changed modules.
- Never commit secrets; keep `.env` local and maintain `.env.example`.

## Agent Workflow Tips

- Determine whether a task targets frontend root, bot, or both.
- Run commands in the correct directory and verify path assumptions.
- Keep changes minimal and aligned with existing architecture.
- Update this file when scripts, tooling, or conventions change.
