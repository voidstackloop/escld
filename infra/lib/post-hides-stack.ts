import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * A viewer's own "not interested" / hide decisions on posts — the feed's
 * first real negative-signal input (see FeedServiceImpl's own doc comment on
 * why every prior signal in this app is purely positive/absent, never
 * negative). Single-partition-per-user, pk=USER#<id> / sk=HIDDEN#<postId> —
 * no reverse edge under the post's own partition, unlike LikesTable: nothing
 * in this app ever needs "who hid this post," only "has this viewer hidden
 * this post," which is answerable entirely from the viewer's own partition.
 * No GSI either — HideStore only ever batch-checks a bounded candidate list
 * (mirroring LikeStore#getLikedPostIds), never needs a recency-ordered scan.
 */
export class PostHidesStack extends cdk.Stack {
  public readonly hidesTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.hidesTable = new dynamodb.Table(this, 'PostHidesTable', {
      tableName: 'post_hides',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Dev-friendly default so `cdk destroy` cleans up fully — matches
      // every other DynamoDB table in this app before it holds real data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'PostHidesTableName', {
      value: this.hidesTable.tableName,
      description: 'DynamoDB table backing per-viewer post hide/not-interested decisions',
    });
  }
}
