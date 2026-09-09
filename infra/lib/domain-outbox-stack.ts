import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/** Transactional outbox shared by DynamoDB-backed domain aggregates. */
export class DomainOutboxStack extends cdk.Stack {
  public readonly outboxTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.outboxTable = new dynamodb.Table(this, 'DomainOutboxTable', {
      tableName: 'domain_outbox',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // A fixed number of deterministic shards prevents one hot PENDING
    // partition while retaining an efficient due-event query for each poll.
    this.outboxTable.addGlobalSecondaryIndex({
      indexName: 'byPendingTime',
      partitionKey: { name: 'pendingShard', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'availableAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    new cdk.CfnOutput(this, 'DomainOutboxTableName', {
      value: this.outboxTable.tableName,
      description: 'DynamoDB transactional outbox for warehouse domain events',
    });
  }
}
