import cors from "cors";
import express, { type Express } from "express";

import type { TrendingEntityType } from "./trending.js";
import type { TrendingEntry } from "./types.js";

export interface TrendingReader {
  getTop(entityType: TrendingEntityType, limit: number): Promise<TrendingEntry[]>;
}

export function createServer(trending: TrendingReader, corsOrigin: string): Express {
  const app = express();
  app.use(cors({ origin: corsOrigin }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/api/v1/analytics/trending/posts", async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const entries = await trending.getTop("posts", limit);
    res.json({ posts: entries.map((e) => ({ postId: e.id, score: e.score })) });
  });

  app.get("/api/v1/analytics/trending/hashtags", async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const entries = await trending.getTop("hashtags", limit);
    res.json({ hashtags: entries.map((e) => ({ tag: e.id, score: e.score })) });
  });

  return app;
}

function clampLimit(raw: unknown): number {
  const parsed = Number.parseInt(typeof raw === "string" ? raw : "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return Math.min(parsed, 50);
}
