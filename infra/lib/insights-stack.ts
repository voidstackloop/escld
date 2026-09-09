import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Materialized per-post and per-creator daily analytics — the destination
 * the "materialize daily series through the exporter into DynamoDB" design
 * (docs/DATA_ANALYSIS_AND_FEED_DESIGN.md §7.2) named but left unbuilt.
 * bq-sink's insights-export.ts writes here (pulling from BigQuery's
 * already-maintained post_daily/creator_daily tables — see canonicalizer.ts
 * — on an hourly cron); the backend reads it directly, read-only, with zero
 * cross-cloud call on any request path.
 *
 * Single table, two entity families distinguished by pk prefix — POST#<id>
 * for PostInsightsService's per-post history, CREATOR#<id> for the
 * account-wide Creator Studio view. Both share the identical sk shape
 * (DATE#<yyyy-mm-dd>), so a range query (`sk BETWEEN DATE#from AND
 * DATE#to`) answers both "this post's last 28 days" and "this creator's
 * last 28 days" with the same access pattern, no GSI needed — mirrors
 * PostHidesStack's own "no GSI, single-partition access pattern is enough"
 * reasoning.
 */
export class InsightsStack extends cdk.Stack {
  public readonly insightsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.insightsTable = new dynamodb.Table(this, 'InsightsTable', {
      tableName: 'insights',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Rebuildable from BigQuery's post_daily/creator_daily on the next
      // export run — not a source of truth, so dev-friendly DESTROY is
      // correct here, matching every other DynamoDB table in this app.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'InsightsTableName', {
      value: this.insightsTable.tableName,
      description: 'DynamoDB table backing materialized per-post and per-creator daily insights (Creator Studio)',
    });
  }
}
