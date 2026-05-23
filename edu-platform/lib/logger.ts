/**
 * Unified structured logger for edu-platform (Next.js + cron-worker).
 *
 * - Production / Docker: outputs newline-delimited JSON to stdout.
 *   Vector reads container stdout via the Docker socket and ships to Loki.
 * - Development (NODE_ENV=development): pretty-prints with pino-pretty.
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   const log = logger.child({ component: "chatService" });
 *   log.info({ sessionId }, "QaLog persisted");
 *   log.error({ err }, "Failed to persist QaLog");
 *
 * Child loggers inherit the parent's `service` binding and add their own fields.
 */

import pino, { type Logger } from "pino";

const isDev = process.env.NODE_ENV === "development";

/** Detect the service name: cron-worker sets WORKER_SERVICE_NAME; Next.js defaults to edu-platform. */
const SERVICE = process.env.WORKER_SERVICE_NAME ?? "edu-platform";

const transport =
  isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname,service",
        },
      }
    : undefined;

export const logger: Logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: SERVICE },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Serialize Error objects properly
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  },
  transport ? pino.transport(transport) : undefined,
);
