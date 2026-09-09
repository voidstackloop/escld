import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class ModerationStack extends cdk.Stack {
  public readonly moderationTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Single-table design backing reports and the moderator audit log, same
    // adjacency-list shape as the follows/feed/conversations tables:
    //
    //   pk=REPORT#<id>,        sk=META                    -> canonical report record
    //   pk=MODQUEUE#OPEN,      sk=REPORT#<createdAt>#<id>  -> open-report queue, deleted on resolve
    //   pk=MOD#<moderatorId>,  sk=ACTION#<createdAt>#<id>  -> per-moderator audit trail
    //
    // See backend ModerationStore.
    this.moderationTable = new dynamodb.Table(this, 'ModerationTable', {
      tableName: 'moderation',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Audit/report data should survive a stack teardown even in early
      // environments, unlike the other single-table stacks here - RETAIN
      // from the start rather than DESTROY.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // NEW_IMAGE (not NEW_AND_OLD, not KEYS_ONLY) is enough: MOD# audit
      // items (see SiemExportStack, the only current stream consumer) are
      // only ever inserted once by logAction, never updated, so there's no
      // "old" state that ever matters for this table's SIEM-export use case.
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    new cdk.CfnOutput(this, 'ModerationTableName', {
      value: this.moderationTable.tableName,
      description: 'DynamoDB table backing reports and the moderator audit log',
    });
  }
}
