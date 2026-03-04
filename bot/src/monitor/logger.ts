import pino from 'pino';
import { getConfig } from './config/index.js';

export function createLogger() {
  const config = getConfig();

  return pino({
    level: config.LOG_LEVEL,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    },
  });
}

export const logger = createLogger();
