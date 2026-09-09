import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";

import type { Logger } from "./logger.js";

/** Accepted envelope bytes for recovery beyond Kafka retention.
 * Same 90-day row-level retention and deletion suppression as raw warehouse
 * data (see DATA_ANALYSIS_AND_FEED_DESIGN §§9, 11.2). Only envelopes already
 * validated by message-handler are archived; malformed JSON is quarantined,
 * not archived. */
export interface ArchiveRecord {
  topic: string;
  partition: number;
  offset: string;
  envelopeJson: string;
}

export interface ArchiveWriter {
  writeBatch(records: ArchiveRecord[]): Promise<void>;
}

export class NoopArchiveWriter implements ArchiveWriter {
  async writeBatch(_records: ArchiveRecord[]): Promise<void> {
    return undefined;
  }
}

/** Gzipped JSONL per Kafka batch, keyed by date + topic/partition/offset.
 * Layout: <prefix>/dt=YYYY-MM-DD/hour=HH/<topic>-<partition>-<firstOffset>.json.gz
 * Bucket must be SSE-encrypted, versioned, lifecycle 90d expiry, RETAIN.
 * A dedicated consumer group (KAFKA_GROUP_ID=s3-archive) is the follow-up;
 * this writer is called best-effort from the BQ landing path so BQ outages
 * do not block archiving intent from being logged and metered. */
export class S3ArchiveWriter implements ArchiveWriter {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly logger: Logger;

  constructor(s3: S3Client, bucket: string, prefix: string, logger: Logger) {
    this.s3 = s3;
    this.bucket = bucket;
    this.prefix = prefix.replace(/\/+$/, "");
    this.logger = logger;
  }

  async writeBatch(records: ArchiveRecord[]): Promise<void> {
    if (records.length === 0) return;
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const hour = now.toISOString().slice(11, 13);
    const first = records[0]!;
    const key =
      `${this.prefix}/dt=${date}/hour=${hour}/` +
      `${first.topic}-${first.partition}-${first.offset}.json.gz`;
    const body = gzipSync(records.map((r) => r.envelopeJson).join("\n"));
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ContentEncoding: "gzip",
      })
    );
    this.logger.info("Archived Kafka batch to S3", {
      bucket: this.bucket,
      key,
      count: records.length,
      bytes: body.length,
    });
  }
}
