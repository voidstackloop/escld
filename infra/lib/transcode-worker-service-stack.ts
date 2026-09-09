import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { addCloudWatchAgentSidecar, otelEnvVars } from './otel-sidecar';

export interface TranscodeWorkerServiceStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  appServiceSecurityGroup: ec2.ISecurityGroup;
  dbInstance: rds.IDatabaseInstance;
  dbSecret: secretsmanager.ISecret;
  transcodeQueue: sqs.IQueue;
  mediaBucket: s3.IBucket;
  mediaCloudFrontDomain: string;
  alertsTopic: sns.ITopic;
}

/**
 * The ffmpeg transcode worker — pure SQS consumer, no inbound traffic from
 * anywhere (not the ALB, not another service), so unlike BackendServiceStack/
 * AnalyticsServiceStack it needs no target group or listener rule. Scales on
 * queue depth rather than CPU: ffmpeg jobs are bursty and I/O-bound in a way
 * CPU% doesn't track well, and queue depth is the direct measure of "is work
 * backing up."
 */
export class TranscodeWorkerServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: TranscodeWorkerServiceStackProps) {
    super(scope, id, props);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      // ffmpeg is CPU-bound (libx264, up to 3 renditions per job) and now
      // runs WORKER_CONCURRENCY jobs genuinely concurrently within one task
      // (see worker/src/index.ts's lane pool) rather than serializing behind
      // a shared batch — 0.5 vCPU wasn't enough headroom for that without
      // every job slowing down under contention.
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    props.transcodeQueue.grantConsumeMessages(taskDefinition.taskRole);
    props.mediaBucket.grantReadWrite(taskDefinition.taskRole);
    props.dbSecret.grantRead(taskDefinition.taskRole);

    // Same reasoning as BackendServiceStack's LogGroup — an explicit
    // retention policy instead of the driver's unmanaged "Never Expire" default.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/escld/transcode-worker',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDefinition.addContainer('worker', {
      image: ecs.ContainerImage.fromAsset('../worker'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'transcode-worker', logGroup }),
      environment: {
        SQS_TRANSCODE_QUEUE_URL: props.transcodeQueue.queueUrl,
        SQS_MAX_RECEIVE_COUNT: '3',
        WORKER_CONCURRENCY: '3',
        HEALTH_PORT: '8080',
        AWS_REGION: this.region,
        MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
        MEDIA_CLOUDFRONT_DOMAIN: props.mediaCloudFrontDomain,
        DB_HOST: props.dbInstance.dbInstanceEndpointAddress,
        DB_PORT: props.dbInstance.dbInstanceEndpointPort,
        DB_NAME: 'escld',
        DB_SSL: 'true',
        // ESM ADOT wiring — same --import/--experimental-loader pair as
        // analytics-service-stack.ts (Phase 0); see otel-sidecar.ts for why.
        // This is the trace-continuity-across-the-SQS-hop half of Phase 1 —
        // the producer side (PostServiceImpl's transcode job publish) isn't
        // itself traced by ADOT (Java's tracing goes through
        // BackendServiceStack's javaagent instead), but X-Ray's own
        // context-propagation-over-message-attributes convention is what
        // would need to be added to actually link the two spans; not done
        // here — this phase gets the worker itself traced/on Application
        // Signals, cross-service span linking is a further, separate step.
        NODE_OPTIONS:
          '--import @aws/aws-distro-opentelemetry-node-autoinstrumentation/register ' +
          '--experimental-loader=@opentelemetry/instrumentation/hook.mjs',
        ...otelEnvVars('escld-transcode-worker'),
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(props.dbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, 'password'),
      },
      // Baked into the image itself (see worker/Dockerfile HEALTHCHECK).
    });

    // X-Ray tracing + CloudWatch Application Signals, Phase 1 — cpu:1024/
    // memoryLimitMiB:2048 (see the TaskDef comment above) already has real
    // headroom above the sidecar's 128/256 reservation, unlike
    // analytics/bq-sink at Fargate's floor, so no task-size bump was needed
    // here.
    addCloudWatchAgentSidecar(this, taskDefinition, 'transcode-worker');

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      securityGroups: [props.appServiceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: 1,
      circuitBreaker: { rollback: true },
      // No ALB in front, so briefly running old+new during a deploy (rather
      // than dropping to 0) just means SQS messages queue up for a few
      // seconds longer — an acceptable trade for not hand-rolling a
      // recreate-style deployment for a single-replica worker.
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    const scaling = this.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 6 });
    scaling.scaleOnMetric('QueueDepthScaling', {
      metric: props.transcodeQueue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 5, change: +1 },
        { lower: 20, change: +3 },
      ],
      cooldown: cdk.Duration.seconds(60),
    });
    // Complements queue depth: depth alone can look healthy even while
    // processing has degraded, since lanes keep receiving messages (just
    // slowly) rather than letting them pile up unreceived. Age of the oldest
    // undeleted message is the direct backlog signal — normal end-to-end
    // processing is a couple of minutes at most, so 10/20 minutes of age is
    // already a real, growing backlog rather than one big-but-normal job.
    // Increase-only (no `upper` step): scale-down stays owned by the queue
    // depth policy above, so the two policies never fight over a decrease.
    scaling.scaleOnMetric('OldestMessageAgeScaling', {
      metric: props.transcodeQueue.metricApproximateAgeOfOldestMessage(),
      scalingSteps: [
        { lower: 600, change: +1 },
        { lower: 1200, change: +3 },
      ],
      cooldown: cdk.Duration.seconds(60),
    });

    // No ALB target group to key a "no healthy targets" alarm off of (see
    // the class doc) — RunningTaskCount from ECS Container Insights is the
    // equivalent signal for a pure background consumer, same pattern already
    // used for BqSinkServiceStack's ServiceDownAlarm.
    new cloudwatch.Alarm(this, 'ServiceDownAlarm', {
      alarmDescription: 'transcode-worker has zero running tasks',
      metric: new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'RunningTaskCount',
        dimensionsMap: { ClusterName: props.cluster.clusterName, ServiceName: this.service.serviceName },
        statistic: 'Minimum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(props.alertsTopic));

    new cdk.CfnOutput(this, 'ServiceName', { value: this.service.serviceName });
  }
}
