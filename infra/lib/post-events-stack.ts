import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface PostEventsStackProps extends cdk.StackProps {
  /** Where the DLQ-depth alarm below notifies — see MonitoringStack. */
  alertsTopic: sns.ITopic;
}

export class PostEventsStack extends cdk.Stack {
  public readonly postEventsQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: PostEventsStackProps) {
    super(scope, id, props);

    // Events that fail 3 times (embedding model hiccup, ES down, etc.) land
    // here for manual inspection instead of retrying forever.
    this.deadLetterQueue = new sqs.Queue(this, 'PostEventsDlq', {
      queueName: 'post-events-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    this.postEventsQueue = new sqs.Queue(this, 'PostEventsQueue', {
      queueName: 'post-events',
      // Embedding + ES index + DynamoDB fan-out is fast (no ffmpeg-scale work),
      // but generous enough that a large follower list's batched fan-out
      // writes don't get raced by a second delivery.
      visibilityTimeout: cdk.Duration.minutes(2),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    new cdk.CfnOutput(this, 'PostEventsQueueUrl', {
      value: this.postEventsQueue.queueUrl,
      description: 'SQS queue the backend publishes post-created events to and the feed worker polls',
    });

    // Same reasoning as TranscodeStack's alarm — DLQ depth is free and
    // otherwise invisible until someone thinks to check.
    new cloudwatch.Alarm(this, 'DlqNotEmptyAlarm', {
      alarmDescription: 'post-events-dlq has messages — events are failing all 3 delivery attempts',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }).addAlarmAction(new cwActions.SnsAction(props.alertsTopic));
  }
}
