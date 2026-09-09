import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PostHidesStack } from '../lib/post-hides-stack';

test('creates the post_hides table with pk/sk keys and no GSI', () => {
  const app = new cdk.App();
  const stack = new PostHidesStack(app, 'TestPostHidesStack1');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'post_hides',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    // No recency/reverse-edge query need exists for hides (see the stack's
    // own doc) — unlike LikesTable, this table intentionally has no GSI.
    GlobalSecondaryIndexes: Match.absent(),
  });
});
