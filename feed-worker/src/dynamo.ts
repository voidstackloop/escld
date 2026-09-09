import {
  BatchWriteItemCommand,
  DynamoDBClient,
  QueryCommand,
  type AttributeValue,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";

const FOLLOWER_PREFIX = "FOLLOWER#";
const POST_PREFIX = "POST#";
const BATCH_SIZE = 25;
// A very-followed account's post can mean tens of thousands of batches — the
// classic fan-out-on-write "celebrity problem." Writing them one batch at a
// time was the actual bottleneck: it holds an SQS message (and its 120s
// visibility timeout) for however long the whole follower list takes, which
// for a large-enough account risks the message becoming visible again and
// getting double-processed. Bounded concurrency shrinks wall-clock time
// roughly proportionally without unbounded parallelism hammering DynamoDB.
const FANOUT_CONCURRENCY = 10;

/**
 * Fan-out-on-write feed writer. Mirrors the backend's FollowGraphStore key
 * scheme (pk = USER#<id>) to read followers, and FeedStore's scheme
 * (pk = USER#<feed owner>, sk = POST#<createdAt>#<postId>) to write feed
 * items — see backend/src/main/java/com/escld/backend/feed/FeedStore.java.
 */
export class FeedFanout {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly followsTable: string,
    private readonly feedTable: string
  ) {}

  async listFollowers(authorId: string): Promise<string[]> {
    const followerIds: string[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.followsTable,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": { S: `USER#${authorId}` },
            ":prefix": { S: FOLLOWER_PREFIX },
          },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of response.Items ?? []) {
        const sk = item.sk?.S;
        if (sk) followerIds.push(sk.slice(FOLLOWER_PREFIX.length));
      }
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return followerIds;
  }

  /** Writes one feed item per recipient (followers + the author's own feed). */
  async fanout(recipientIds: string[], postId: string, authorId: string, createdAt: string): Promise<void> {
    const writeRequests: WriteRequest[] = recipientIds.map((recipientId) => ({
      PutRequest: {
        Item: {
          pk: { S: `USER#${recipientId}` },
          sk: { S: `${POST_PREFIX}${createdAt}#${postId}` },
          postId: { S: postId },
          authorId: { S: authorId },
          createdAt: { S: createdAt },
        },
      },
    }));

    const batches: WriteRequest[][] = [];
    for (let i = 0; i < writeRequests.length; i += BATCH_SIZE) {
      batches.push(writeRequests.slice(i, i + BATCH_SIZE));
    }

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        const batch = batches[index];
        if (!batch) return;
        await this.writeBatchWithRetry(batch);
      }
    };

    const workerCount = Math.min(FANOUT_CONCURRENCY, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  private async writeBatchWithRetry(batch: WriteRequest[], attempt = 1): Promise<void> {
    const response = await this.client.send(
      new BatchWriteItemCommand({ RequestItems: { [this.feedTable]: batch } })
    );

    const unprocessed = response.UnprocessedItems?.[this.feedTable];
    if (unprocessed && unprocessed.length > 0) {
      if (attempt >= 5) {
        // Retain retry/DLQ evidence: throwing (not returning) lets SQS
        // redrive move the post event to the DLQ with its receive-count
        // history instead of falsely reporting fan-out success.
        throw new Error(
          `Exhausted fan-out retries with ${unprocessed.length} unprocessed items after ${attempt} attempts`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      await this.writeBatchWithRetry(unprocessed, attempt + 1);
    }
  }
}
