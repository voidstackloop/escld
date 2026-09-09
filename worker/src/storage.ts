import { createWriteStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { logger } from "./logger.js";

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/MP2T",
};

async function withRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  attempts = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new Error(`${operation} aborted before attempt ${attempt}`);
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && !signal?.aborted) {
        const delayMs = 500 * 2 ** (attempt - 1);
        logger.warn("Transient error, retrying", { operation, attempt, attempts, delayMs });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

export class Storage {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(region: string, bucket: string, endpoint: string | undefined) {
    this.s3 = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
    this.bucket = bucket;
  }

  /** `signal` bounds a stuck download (a stalled connection has no other
   * built-in ceiling) so it can never strand a worker slot forever — the
   * caller aborts it once the job's overall deadline passes. */
  async download(key: string, destPath: string, signal?: AbortSignal): Promise<void> {
    await withRetry(
      "s3.download",
      async () => {
        const response = await this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: key }),
          signal ? { abortSignal: signal } : {}
        );
        if (!response.Body) {
          throw new Error(`Empty response body for s3://${this.bucket}/${key}`);
        }
        await pipeline(response.Body as Readable, createWriteStream(destPath), { signal });
      },
      signal
    );
  }

  async uploadDirectory(localDir: string, s3Prefix: string, signal?: AbortSignal): Promise<void> {
    const files = await readdir(localDir);
    await Promise.all(
      files.map((file) =>
        withRetry(
          `s3.upload:${file}`,
          async () => {
            const body = await readFile(path.join(localDir, file));
            const ext = path.extname(file);
            await this.s3.send(
              new PutObjectCommand({
                Bucket: this.bucket,
                Key: `${s3Prefix}/${file}`,
                Body: body,
                ContentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
              }),
              signal ? { abortSignal: signal } : {}
            );
          },
          signal
        )
      )
    );
  }
}
