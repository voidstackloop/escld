import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template } from 'aws-cdk-lib/assertions';
import { PostEventsStack } from '../lib/post-events-stack';

test('creates a post-events queue with a dead-letter queue after 3 retries', () => {
  const app = new cdk.App();
  const alertsStack = new cdk.Stack(app, 'TestAlertsStack');
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');
  const stack = new PostEventsStack(app, 'TestPostEventsStack', { alertsTopic });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::SQS::Queue', 2);

  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'post-events',
    RedrivePolicy: {
      maxReceiveCount: 3,
    },
  });

  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'post-events-dlq',
  });
});
