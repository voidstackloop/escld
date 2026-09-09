export type MediaType = "VIDEO" | "AUDIO";

export interface TranscodeJob {
  postId: string;
  mediaKey: string;
  mediaType: MediaType;
}

export function isTranscodeJob(value: unknown): value is TranscodeJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    typeof job.postId === "string" &&
    typeof job.mediaKey === "string" &&
    (job.mediaType === "VIDEO" || job.mediaType === "AUDIO")
  );
}

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

export interface WorkerConfig {
  awsRegion: string;
  sqsEndpoint: string | undefined;
  s3Endpoint: string | undefined;
  queueUrl: string;
  mediaBucket: string;
  cloudfrontDomain: string;
  concurrency: number;
  maxReceiveCount: number;
  healthPort: number;
  db: DbConfig;
}
