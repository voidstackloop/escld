import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class LikesStack extends cdk.Stack {
  public readonly likesTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Adjacency-list post likes: one item per like, written under both the
    // post's and the liker's partitions (pk = POST#<id> / USER#<id>) so
    // "does X like post Y" and "which of these posts has X liked" are each
    // a single-item/single-request read. Same shape as the follows table.
    // See backend LikeStore. The like *count* stays a denormalized counter
    // on the Postgres `posts` row, not here.
    this.likesTable = new dynamodb.Table(this, 'LikesTable', {
      tableName: 'likes',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Dev-friendly default so `cdk destroy` cleans up fully. Switch to RETAIN
      // before this holds real like data.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The base table's sk (LIKE#<userId> / LIKED#<postId>) isn't date-ordered,
    // so "this viewer's most recently liked posts" (feed-ranking's per-author/
    // tag affinity signal, see FeedServiceImpl) can't be queried off it — a
    // plain Limit() on the base table returns an arbitrary, permanently-frozen
    // subset (whichever ids sort lowest as strings), not a recent-N window.
    // Every item already writes `createdAt` (see LikeStore#item) — this GSI
    // just exposes it for a genuinely recency-ordered query. KEYS_ONLY:
    // LikeStore only ever needs the post id back, not the rest of the item.
    // No backfill needed — DynamoDB populates GSIs from existing items.
    this.likesTable.addGlobalSecondaryIndex({
      indexName: 'byUserRecency',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    new cdk.CfnOutput(this, 'LikesTableName', {
      value: this.likesTable.tableName,
      description: 'DynamoDB table backing post likes',
    });
  }
}
