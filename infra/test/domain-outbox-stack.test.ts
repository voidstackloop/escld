import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { DomainOutboxStack } from '../lib/domain-outbox-stack';

test('creates a TTL-backed sharded pending-event index', () => {
  const stack = new DomainOutboxStack(new cdk.App(), 'TestDomainOutboxStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'domain_outbox',
    BillingMode: 'PAY_PER_REQUEST',
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    GlobalSecondaryIndexes: [{
      IndexName: 'byPendingTime',
      KeySchema: [
        { AttributeName: 'pendingShard', KeyType: 'HASH' },
        { AttributeName: 'availableAt', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    }],
  });
});
