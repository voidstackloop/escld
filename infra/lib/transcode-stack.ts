import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface TranscodeStackProps extends cdk.StackProps {
  /** Where the DLQ-depth alarm below notifies — see MonitoringStack. */
  alertsTopic: sns.ITopic;
}

export class TranscodeStack extends cdk.Stack {
  public readonly transcodeQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: TranscodeStackProps) {
    super(scope, id, props);

    // Jobs that fail 3 times (worker error, corrupt upload, etc.) land here for
    // manual inspection instead of retrying forever.
    this.deadLetterQueue = new sqs.Queue(this, 'TranscodeJobsDlq', {
      queueName: 'transcode-jobs-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    this.transcodeQueue = new sqs.Queue(this, 'TranscodeJobsQueue', {
      queueName: 'transcode-jobs',
      // Generous — video transcoding can take a while; the message must stay
      // invisible for the whole job so another worker doesn't pick it up too.
      visibilityTimeout: cdk.Duration.minutes(10),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    new cdk.CfnOutput(this, 'TranscodeQueueUrl', {
      value: this.transcodeQueue.queueUrl,
      description: 'SQS queue the backend publishes transcode jobs to and the ffmpeg worker polls',
    });

    // DLQ depth is a free, zero-extra-code signal SQS already emits — a
    // non-zero value here means jobs are being permanently given up on
    // (bad uploads, or a worker-side regression), which today is otherwise
    // invisible until someone thinks to check.
    new cloudwatch.Alarm(this, 'DlqNotEmptyAlarm', {
      alarmDescription: 'transcode-jobs-dlq has messages — jobs are failing all 3 delivery attempts',
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
