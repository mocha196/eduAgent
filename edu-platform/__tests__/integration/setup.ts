/**
 * Integration test global setup: load environment variables from .env.local
 * so that lib/config.ts functions return real service URLs.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
