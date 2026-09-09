import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { InsightsStack } from '../lib/insights-stack';

test('creates the insights table with pk/sk keys and no GSI', () => {
  const app = new cdk.App();
  const stack = new InsightsStack(app, 'TestInsightsStack1');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'insights',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    // Both POST# and CREATOR# series share the same sk shape (DATE#...), so
    // one range-query access pattern answers both — no GSI needed.
    GlobalSecondaryIndexes: Match.absent(),
  });
});

test('is rebuildable from BigQuery, so removal policy is DESTROY not RETAIN', () => {
  const app = new cdk.App();
  const stack = new InsightsStack(app, 'TestInsightsStack2');
  const template = Template.fromStack(stack);

  template.hasResource('AWS::DynamoDB::Table', {
    DeletionPolicy: 'Delete',
  });
});
