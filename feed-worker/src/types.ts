export interface PostCreatedEvent {
  eventType: "CREATED";
  postId: string;
  authorId: string;
  text: string;
  tags: string[];
  createdAt: string;
}

export function isPostCreatedEvent(value: unknown): value is PostCreatedEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.eventType === "CREATED" &&
    typeof v.postId === "string" &&
    typeof v.authorId === "string" &&
    typeof v.text === "string" &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === "string") &&
    typeof v.createdAt === "string"
  );
}

export interface WorkerConfig {
  awsRegion: string;
  sqsEndpoint: string | undefined;
  dynamoEndpoint: string | undefined;
  queueUrl: string;
  concurrency: number;
  maxReceiveCount: number;
  healthPort: number;
  elasticsearchUrl: string;
  postsIndex: string;
  followsTableName: string;
  feedTableName: string;
}
