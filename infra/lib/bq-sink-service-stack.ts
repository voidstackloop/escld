import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

import { grantMskClientAccess } from './msk-iam-policy';
import { addCloudWatchAgentSidecar, otelEnvVars } from './otel-sidecar';

export interface BqSinkServiceStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  appServiceSecurityGroup: ec2.ISecurityGroup;
  mskClusterArn: string;
  bigQueryProjectId: string;
  bigQueryDataset: string;
  // Full resource name of the GCP Workload Identity Federation AWS
  // provider (see bq-sink/setup-gcp.sh's final printed value) — the
  // audience bq-sink's ExternalAccountClient presents to GCP's STS.
  gcpWorkloadIdentityProvider: string;
  // Defaults to setup-gcp.sh's fixed naming convention
  // (bq-sink@<project>.iam.gserviceaccount.com) when omitted. Explicit
  // rather than silently derived everywhere in this stack, so a naming
  // convention change surfaces as a visible cdk diff, not an opaque STS
  // auth failure at runtime — see the plan's own reasoning for this call.
  gcpServiceAccountEmail?: string;
  alertsTopic: sns.ITopic;
  /**
   * Optional so a bq-sink deploy never depends on InsightsStack existing
   * first — absent means the insights-export.ts cron loop simply never
   * starts (see index.ts), same graceful-degradation shape as every other
   * optional integration in this app. Write-only: bq-sink is the sole
   * writer of materialized daily insights; the backend only ever reads.
   */
  insightsTable?: dynamodb.ITable;
}

/**
 * The AWS->GCP bridge: consumes MSK Serverless topics via IAM-authenticated
 * Kafka, writes rows to BigQuery via streaming insert — see the plan's §4
 * for why this is a small purpose-built service rather than MSK Connect (a
 * generic connector framework this repo has no precedent operating) or a
 * Pub/Sub+Dataflow detour (two more managed services for no benefit at this
 * volume). No ALB — this is a pure background consumer, same shape as
 * TranscodeWorkerServiceStack/FeedWorkerServiceStack, not AnalyticsServiceStack
 * (which serves the frontend directly and needs one).
 */
export class BqSinkServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: BqSinkServiceStackProps) {
    super(scope, id, props);

    // Explicit, stable name — a deliberate first for this codebase (every
    // other stack lets CDK auto-name its IAM roles). GCP's Workload Identity
    // Federation trust config (bq-sink/setup-gcp.sh) has to reference this
    // exact role's assumed-role identity, and needs to be able to do so
    // independently of whether this stack has ever been deployed — an
    // auto-generated name would only be known after a first `cdk deploy`,
    // making GCP-side setup depend on AWS deploy order for no real reason.
    // A fixed name also survives a full stack teardown/recreation (DR,
    // region migration, accidental destroy) without silently breaking the
    // GCP trust relationship — an auto-generated name is stable across
    // ordinary updates but not guaranteed stable across recreation.
    // Trade-off, accepted deliberately: if any future change ever forces
    // CloudFormation to *replace* this role, a create-before-delete
    // collision on the fixed name will fail the deploy outright and need
    // manual cleanup — likely the real reason this codebase otherwise
    // avoids fixed role names everywhere else.
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'escld-bq-sink-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      // Bumped from Fargate's floor (256/512) for Phase 1 of the X-Ray/
      // Application Signals rollout — same forced reasoning as
      // analytics-service-stack.ts's identical bump: 256/512 left zero
      // headroom for the ecs-cwagent sidecar's own 256MB reservation.
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
    });

    grantMskClientAccess(this, taskDefinition.taskRole, props.mskClusterArn, 'consumer');
    // No Secrets Manager grant needed — bq-sink authenticates to GCP via
    // Workload Identity Federation (this task role's own identity,
    // federated through GCP's STS), not a downloaded service-account key.
    // See gcp-auth.ts and bq-sink/setup-gcp.sh.
    props.insightsTable?.grantWriteData(taskDefinition.taskRole);

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/escld/bq-sink',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const container = taskDefinition.addContainer('bq-sink', {
      image: ecs.ContainerImage.fromAsset('../bq-sink'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'bq-sink', logGroup }),
      environment: {
        HEALTH_PORT: '4200',
        AWS_REGION: this.region,
        KAFKA_CLUSTER_ARN: props.mskClusterArn,
        // One topic per event type, matching WarehouseEventPublisher.ALL_TOPICS
        // on the producer side and bigquery.ts's TABLE_BY_EVENT_TYPE mapping
        // on this side — live.started/live.ended added alongside the
        // original post/user event set for the live-streaming feature.
        KAFKA_TOPICS: 'post.created,post.liked,post.unliked,post.commented,post.comment_deleted,post.hidden,post.unhidden,user.followed,user.unfollowed,live.started,live.ended,post.impression,post.dwell,feed.served,media.progress',
        KAFKA_GROUP_ID: 'bq-sink',
        GCP_WORKLOAD_IDENTITY_PROVIDER: props.gcpWorkloadIdentityProvider,
        GCP_SERVICE_ACCOUNT_EMAIL:
          props.gcpServiceAccountEmail ?? `bq-sink@${props.bigQueryProjectId}.iam.gserviceaccount.com`,
        BIGQUERY_PROJECT_ID: props.bigQueryProjectId,
        BIGQUERY_DATASET: props.bigQueryDataset,
        BIGQUERY_ANALYTICS_DATASET: 'escld_analytics',
        BIGQUERY_BATCH_SIZE: '500',
        CANONICALIZATION_INTERVAL_MS: '300000',
        CANONICALIZATION_LOOKBACK_DAYS: '2',
        RECONCILIATION_INTERVAL_MS: '86400000',
        RECONCILIATION_LOOKBACK_DAYS: '30',
        INITIAL_RECONCILIATION_LOOKBACK_DAYS: '3650',
        // Absent (no insightsTable prop) disables this cron loop entirely —
        // see index.ts. Hourly, not tied to CANONICALIZATION_INTERVAL_MS:
        // post_daily/creator_daily only meaningfully change on that 5-minute
        // cadence anyway, and Creator Studio has no sub-hour freshness need.
        ...(props.insightsTable ? {
          DYNAMODB_INSIGHTS_TABLE: props.insightsTable.tableName,
          INSIGHTS_EXPORT_INTERVAL_MS: '3600000',
          INSIGHTS_EXPORT_LOOKBACK_DAYS: '3',
        } : {}),
        // ESM ADOT wiring — see otel-sidecar.ts / analytics-service-stack.ts.
        // Traces bq-sink's own Kafka-consume -> BigQuery-insert path; doesn't
        // by itself link back to the Java producer's span (see
        // transcode-worker-service-stack.ts's identical caveat about the
        // SQS hop — same gap here for the Kafka hop, cross-service span
        // linking is a further step, not done in this phase).
        NODE_OPTIONS:
          '--import @aws/aws-distro-opentelemetry-node-autoinstrumentation/register ' +
          '--experimental-loader=@opentelemetry/instrumentation/hook.mjs',
        ...otelEnvVars('escld-bq-sink'),
      },
      // Baked into the image itself (see bq-sink/Dockerfile HEALTHCHECK).
    });
    container.addPortMappings({ containerPort: 4200 });

    // X-Ray tracing + CloudWatch Application Signals, Phase 1 — see
    // otel-sidecar.ts.
    addCloudWatchAgentSidecar(this, taskDefinition, 'bq-sink');

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      securityGroups: [props.appServiceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: 1,
      circuitBreaker: { rollback: true },
      // Same reasoning as the SQS workers — no ALB, so briefly running
      // old+new during a deploy beats dropping to 0 running tasks.
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    // Phase 0 scope is proving the pipe works, not scaling it — a single
    // consumer in one group is simpler to reason about and enough at this
    // event volume (see the plan's §8). Revisit alongside broadening the
    // event taxonomy in a later phase.

    new cloudwatch.Alarm(this, 'ServiceDownAlarm', {
      alarmDescription: 'bq-sink has zero running tasks',
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
