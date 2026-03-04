import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const marketLogger = pino({
  level,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
});
