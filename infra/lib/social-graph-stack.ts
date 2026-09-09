import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class SocialGraphStack extends cdk.Stack {
  public readonly followsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Adjacency-list social graph: one item per follow edge, written under both
    // users' partitions (pk = USER#<id>) so "who follows X" / "who does X follow"
    // are each a single-partition query. See backend FollowGraphStore.
    this.followsTable = new dynamodb.Table(this, 'FollowsTable', {
      tableName: 'follows',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Dev-friendly default so `cdk destroy` cleans up fully. Switch to RETAIN
      // before this holds real follow relationships.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'FollowsTableName', {
      value: this.followsTable.tableName,
      description: 'DynamoDB table backing the social graph (followers/following)',
    });
  }
}
