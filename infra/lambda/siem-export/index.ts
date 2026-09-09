import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';

const s3 = new S3Client({});

const bucketName = process.env.SIEM_EXPORT_BUCKET_NAME;
if (!bucketName) {
  throw new Error('SIEM_EXPORT_BUCKET_NAME environment variable is required');
}

/**
 * Exports the moderation audit trail (ModerationStore's `MOD#<moderatorId>`
 * items — see backend/src/main/java/.../moderation/ModerationStore.java) to
 * a plain S3 bucket for downstream SIEM ingestion, as a real destination
 * rather than the previously-deferred "no compliance requirement yet."
 *
 * The event source mapping (see SiemExportStack) already filters invocations
 * server-side to INSERT events on MOD#-prefixed partition keys — the
 * `eventName`/pk checks below are defense-in-depth, not the primary filter,
 * since a stream processor should never trust its trigger configuration as
 * the only thing standing between it and unexpected input.
 *
 * Each audit item is written as its own S3 object (`ACTION#<createdAt>#<id>`
 * items are only ever inserted once — see logAction, no updates), keyed by
 * the DynamoDB Streams event ID for guaranteed uniqueness without parsing
 * the item first, and date-partitioned so a security team's downstream
 * ingestion can select by day. Uses reportBatchItemFailures so one bad
 * record in a batch (a malformed image, a transient S3 error) only retries
 * that record — not the whole batch, which at this table's low write volume
 * would otherwise reprocess already-exported items on every retry.
 */
export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage || !record.dynamodb.Keys?.pk) {
      continue;
    }
    const pk = record.dynamodb.Keys.pk.S;
    if (!pk?.startsWith('MOD#')) {
      continue;
    }

    try {
      const item = unmarshall(record.dynamodb.NewImage as unknown as Record<string, AttributeValue>);
      const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();
      const datePartition = createdAt.slice(0, 10); // YYYY-MM-DD
      const key = `moderation-actions/dt=${datePartition}/${record.eventID}.json`;

      await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: JSON.stringify(item),
        ContentType: 'application/json',
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'Failed to export moderation action to S3',
        eventID: record.eventID,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (record.dynamodb.SequenceNumber) {
        batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      }
    }
  }

  return { batchItemFailures };
}
