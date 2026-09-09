import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template } from 'aws-cdk-lib/assertions';
import { TranscodeStack } from '../lib/transcode-stack';

test('creates a transcode jobs queue with a dead-letter queue after 3 retries', () => {
  const app = new cdk.App();
  const alertsStack = new cdk.Stack(app, 'TestAlertsStack');
  const alertsTopic = new sns.Topic(alertsStack, 'TestAlertsTopic');
  const stack = new TranscodeStack(app, 'TestTranscodeStack', { alertsTopic });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::SQS::Queue', 2);

  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'transcode-jobs',
    RedrivePolicy: {
      maxReceiveCount: 3,
    },
  });

  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'transcode-jobs-dlq',
  });
});
