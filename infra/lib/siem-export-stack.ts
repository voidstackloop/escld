import * as path from 'node:path';

import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface SiemExportStackProps extends cdk.StackProps {
  moderationTable: dynamodb.ITable;
}

/**
 * Streams the moderation audit trail (ModerationStore's `MOD#<moderatorId>`
 * items — see backend/src/main/java/.../moderation/ModerationStore.java's
 * logAction) out to a dedicated S3 bucket for downstream SIEM ingestion.
 * Closes a gap the telemetry plan explicitly left deferred ("a compliance
 * requirement or external auditor actually asks for it") — asked directly
 * rather than assumed, and the answer was a plain S3 bucket a security team
 * can query/ingest from, not a specific vendor (Splunk/Datadog), so this is
 * the simplest version of "get the data out of DynamoDB and into something
 * durable and queryable outside the app."
 *
 * DynamoDB Streams -> a small purpose-built Lambda -> S3, not Kinesis Data
 * Streams -> Firehose -> S3 — at this table's actual write volume (moderator
 * actions only, not general app traffic), Firehose's buffering/batching
 * machinery solves a scale problem this table doesn't have. Matches this
 * repo's established preference for a small explicit consumer over a
 * generic managed pipeline at low volume (see bq-sink's identical reasoning
 * for choosing a purpose-built bridge service over MSK Connect).
 *
 * Only the audit trail is exported, not the whole shared moderation table —
 * REPORT#/MODQUEUE# items are the report-filing workflow, a different
 * concern from "which moderator did what," and the event source's filter
 * criteria (below) excludes them at the Lambda-invocation level, not just in
 * application code, so they never even trigger a cold start for this.
 */
export class SiemExportStack extends cdk.Stack {
  public readonly exportBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: SiemExportStackProps) {
    super(scope, id, props);

    // RETAIN, not DESTROY (unlike most of this app's dev-friendly stacks) —
    // this bucket exists specifically so audit data survives independently
    // of the rest of the app's infrastructure lifecycle; losing it on a
    // stack teardown would defeat the entire point of exporting it. Matches
    // ModerationStack's own table, which made the identical call for the
    // identical reason.
    this.exportBucket = new s3.Bucket(this, 'ExportBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
    });

    const logGroup = new logs.LogGroup(this, 'ExportFunctionLogGroup', {
      logGroupName: '/escld/siem-export',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const exportFunction = new nodejs.NodejsFunction(this, 'ExportFunction', {
      // Absolute path, not a relative string literal — NodejsFunction's
      // relative-path resolution infers the calling file's location from
      // the JS call stack, which isn't reliable under ts-jest (confirmed:
      // it threw CannotFindEntryFile in this exact test suite) even though
      // it works fine under a plain `cdk synth`/`ts-node` run.
      entry: path.join(__dirname, '..', 'lambda', 'siem-export', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup,
      environment: {
        SIEM_EXPORT_BUCKET_NAME: this.exportBucket.bucketName,
      },
      // client-s3 is present in the Node 22 Lambda runtime's bundled AWS
      // SDK v3 — externalizing it keeps the deployed bundle small.
      // util-dynamodb/client-dynamodb (needed to unmarshall stream records)
      // are NOT part of that curated runtime bundle, so those stay bundled.
      bundling: {
        externalModules: ['@aws-sdk/client-s3'],
      },
    });

    this.exportBucket.grantWrite(exportFunction);

    exportFunction.addEventSource(new lambdaEventSources.DynamoEventSource(props.moderationTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 25,
      retryAttempts: 3,
      // One bad record (a malformed image, a transient S3 error) only
      // retries that record, not the whole batch — at this table's low
      // write volume, whole-batch retries would otherwise needlessly
      // re-export already-succeeded items on every transient failure.
      reportBatchItemFailures: true,
      filters: [
        lambda.FilterCriteria.filter({
          eventName: lambda.FilterRule.isEqual('INSERT'),
          dynamodb: { Keys: { pk: { S: lambda.FilterRule.beginsWith('MOD#') } } },
        }),
      ],
    }));

    new cdk.CfnOutput(this, 'ExportBucketName', {
      value: this.exportBucket.bucketName,
      description: 'S3 bucket the moderation audit trail is exported to for SIEM ingestion',
    });
  }
}
