import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class FeedStack extends cdk.Stack {
  public readonly feedTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Fan-out-on-write feed: one item per (feed owner, post) pair, written
    // under the owner's partition (pk = USER#<id>) by the feed worker when
    // someone they follow posts. sk = POST#<createdAt ISO-8601>#<postId> so a
    // single descending query returns the newest posts first. See backend
    // FeedStore (read) and feed-worker/src/dynamo.ts (fan-out write).
    this.feedTable = new dynamodb.Table(this, 'FeedTable', {
      tableName: 'feed',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Dev-friendly default so `cdk destroy` cleans up fully. Switch to RETAIN
      // before this holds real feed data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'FeedTableName', {
      value: this.feedTable.tableName,
      description: 'DynamoDB table backing the fan-out-on-write posts feed',
    });
  }
}
