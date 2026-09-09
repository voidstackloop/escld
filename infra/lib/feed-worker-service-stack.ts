import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { addCloudWatchAgentSidecar, otelEnvVars } from './otel-sidecar';

export interface FeedWorkerServiceStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  appServiceSecurityGroup: ec2.ISecurityGroup;
  postEventsQueue: sqs.IQueue;
  followsTable: dynamodb.ITable;
  feedTable: dynamodb.ITable;
  /** SearchStack's Cloud Map DNS name — see BackendServiceStack's prop of the same name for why this is a plain string, not a cross-stack reference. */
  elasticsearchUri: string;
  alertsTopic: sns.ITopic;
}

/**
 * Consumes SQS post-created events: embeds the post text, indexes it into
 * Elasticsearch, and fans the post out to every follower's DynamoDB feed
 * item (see feed-worker/src/index.ts). Pure background consumer, same shape
 * as TranscodeWorkerServiceStack — no ALB target group.
 */
export class FeedWorkerServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: FeedWorkerServiceStackProps) {
    super(scope, id, props);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      // The ~90MB ONNX embedding model loads lazily on first event (see
      // feed-worker/src/index.ts) rather than at startup, but still needs
      // headroom once it does. Memory bumped 1024->2048 for Phase 1 of the
      // X-Ray/Application Signals rollout (see otel-sidecar.ts): this task
      // was already flagged in the telemetry plan as "genuinely marginal"
      // on memory before the sidecar's own 256MB reservation was added on
      // top — the same forced-bump reasoning as analytics/bq-sink's
      // Fargate-floor bumps, just starting from a higher, already-tight
      // baseline rather than the floor itself.
      cpu: 512,
      memoryLimitMiB: 2048,
    });

    props.postEventsQueue.grantConsumeMessages(taskDefinition.taskRole);
    props.followsTable.grantReadData(taskDefinition.taskRole);
    props.feedTable.grantWriteData(taskDefinition.taskRole);

    // Same reasoning as BackendServiceStack's LogGroup.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/escld/feed-worker',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDefinition.addContainer('feed-worker', {
      image: ecs.ContainerImage.fromAsset('../feed-worker'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'feed-worker', logGroup }),
      environment: {
        SQS_POST_EVENTS_QUEUE_URL: props.postEventsQueue.queueUrl,
        SQS_MAX_RECEIVE_COUNT: '3',
        WORKER_CONCURRENCY: '4',
        HEALTH_PORT: '8080',
        AWS_REGION: this.region,
        DYNAMODB_FOLLOWS_TABLE: props.followsTable.tableName,
        DYNAMODB_FEED_TABLE: props.feedTable.tableName,
        ELASTICSEARCH_URL: props.elasticsearchUri,
        POSTS_SEARCH_INDEX: 'posts_search',
        // ESM ADOT wiring — see transcode-worker-service-stack.ts's identical
        // block and otel-sidecar.ts for the shared reasoning.
        NODE_OPTIONS:
          '--import @aws/aws-distro-opentelemetry-node-autoinstrumentation/register ' +
          '--experimental-loader=@opentelemetry/instrumentation/hook.mjs',
        ...otelEnvVars('escld-feed-worker'),
      },
      // Baked into the image itself (see feed-worker/Dockerfile HEALTHCHECK).
    });

    // X-Ray tracing + CloudWatch Application Signals, Phase 1 — see
    // otel-sidecar.ts.
    addCloudWatchAgentSidecar(this, taskDefinition, 'feed-worker');

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      securityGroups: [props.appServiceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: 1,
      circuitBreaker: { rollback: true },
      // Same reasoning as TranscodeWorkerServiceStack — no ALB, so a brief
      // old+new overlap during deploys beats dropping to 0 running tasks.
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    const scaling = this.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 6 });
    scaling.scaleOnMetric('QueueDepthScaling', {
      metric: props.postEventsQueue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 10, change: +1 },
        { lower: 50, change: +3 },
      ],
      cooldown: cdk.Duration.seconds(60),
    });
    // Complements queue depth for the same reason as TranscodeWorkerServiceStack:
    // depth alone can look healthy while processing has quietly degraded.
    // Normal fan-out/embed/index processing finishes in low single-digit
    // seconds, so an oldest-message age in the low minutes already signals a
    // real backlog. Increase-only — scale-down stays owned by the queue
    // depth policy above.
    scaling.scaleOnMetric('OldestMessageAgeScaling', {
      metric: props.postEventsQueue.metricApproximateAgeOfOldestMessage(),
      scalingSteps: [
        { lower: 120, change: +1 },
        { lower: 300, change: +3 },
      ],
      cooldown: cdk.Duration.seconds(60),
    });

    // No ALB target group to key a "no healthy targets" alarm off of (see
    // the class doc) — RunningTaskCount from ECS Container Insights is the
    // equivalent signal for a pure background consumer, same pattern already
    // used for BqSinkServiceStack's ServiceDownAlarm.
    new cloudwatch.Alarm(this, 'ServiceDownAlarm', {
      alarmDescription: 'feed-worker has zero running tasks',
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
