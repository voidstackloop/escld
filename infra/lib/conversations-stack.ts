import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class ConversationsStack extends cdk.Stack {
  public readonly conversationsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Single-table design backing ws-sfu's messaging, same adjacency-list
    // shape as the follows/feed tables:
    //
    //   pk=CONVO#<id>,   sk=META                       -> conversation metadata
    //   pk=CONVO#<id>,   sk=MSG#<createdAt>#<msgId>     -> one item per message
    //   pk=USER#<id>,    sk=CONVO#<lastMsgAt>#<convoId> -> per-user inbox, fanned
    //                                                      out on send so "list my
    //                                                      conversations, newest
    //                                                      first" is one query
    //   pk=DMPAIR#<a>#<b>, sk=META                      -> dedup lookup so two
    //                                                      users only ever get one
    //                                                      DM thread between them
    this.conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: 'conversations',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Dev-friendly default so `cdk destroy` cleans up fully. Switch to RETAIN
      // before this holds real conversations.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'ConversationsTableName', {
      value: this.conversationsTable.tableName,
      description: 'DynamoDB table backing ws-sfu messaging (conversations, messages, inbox fan-out)',
    });
  }
}
