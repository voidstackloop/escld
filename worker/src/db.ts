import { Pool } from "pg";

import { logger } from "./logger.js";
import type { DbConfig } from "./types.js";

export function createPool(config: DbConfig): Pool {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Bounds a query that would otherwise hang indefinitely on a wedged
    // connection — markReady/markFailed are single-row updates, so this is
    // generous, not tight.
    statement_timeout: 30_000,
  });

  // pg emits 'error' on the pool when an *idle* client hits a network error
  // (e.g. the DB restarting or a connection reset) — with no listener, that
  // is an unhandled EventEmitter error, which crashes the whole process. The
  // pool itself recovers on its own (it just drops the bad client); this
  // only needs to exist so the crash doesn't happen.
  pool.on("error", (error) => {
    logger.error("Postgres pool error on an idle client", { error });
  });

  return pool;
}

export async function markReady(pool: Pool, postId: string, mediaUrl: string): Promise<void> {
  await pool.query(`UPDATE posts SET media_status = 'READY', media_url = $2 WHERE id = $1`, [
    postId,
    mediaUrl,
  ]);
}

export async function markFailed(pool: Pool, postId: string): Promise<void> {
  await pool.query(`UPDATE posts SET media_status = 'FAILED' WHERE id = $1`, [postId]);
}
