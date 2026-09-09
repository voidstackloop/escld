import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

import { addCloudWatchAgentSidecar, otelEnvVars } from './otel-sidecar';

export interface AnalyticsServiceStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  httpListener: elbv2.ApplicationListener;
  appServiceSecurityGroup: ec2.ISecurityGroup;
  redisCluster: elasticache.CfnCacheCluster;
  corsAllowedOrigins: string;

  /** Where this stack's alarm notifies — see MonitoringStack. */
  alertsTopic: sns.ITopic;
}

/**
 * Consumes the Redis pub/sub channel AnalyticsEventPublisher (backend) writes
 * to and serves trending posts/hashtags — called directly by the frontend
 * (see frontend/src/lib/analytics.ts), not proxied through the Java backend,
 * so it gets its own ALB target group and listener rule rather than living
 * inside BackendServiceStack.
 */
export class AnalyticsServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: AnalyticsServiceStackProps) {
    super(scope, id, props);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      // Was 256/512 (Fargate's minimum combo) — bumped to fit the
      // ecs-cwagent sidecar this stack now adds for X-Ray tracing +
      // CloudWatch Application Signals (see otel-sidecar.ts); 256/512 left
      // zero headroom for a second container at all.
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    // Same reasoning as BackendServiceStack's LogGroup.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/escld/analytics',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const container = taskDefinition.addContainer('analytics', {
      image: ecs.ContainerImage.fromAsset('../analytics'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'analytics', logGroup }),
      environment: {
        PORT: '4100',
        CORS_ALLOWED_ORIGINS: props.corsAllowedOrigins,
        REDIS_HOST: props.redisCluster.attrRedisEndpointAddress,
        REDIS_PORT: props.redisCluster.attrRedisEndpointPort,
        // ADOT auto-instrumentation, loaded via NODE_OPTIONS rather than an
        // application code change — analytics is ESM ("type": "module" in
        // package.json), so this is the --import/--experimental-loader
        // pair AWS documents for ESM specifically (the CommonJS init-
        // container/--require pattern doesn't apply here). See otel-
        // sidecar.ts's own doc comment for why ADOT, not the older
        // aws-xray-sdk-node (in maintenance mode since Feb 2026).
        NODE_OPTIONS:
          '--import @aws/aws-distro-opentelemetry-node-autoinstrumentation/register ' +
          '--experimental-loader=@opentelemetry/instrumentation/hook.mjs',
        ...otelEnvVars('escld-analytics'),
      },
      // Baked into the image itself (see analytics/Dockerfile HEALTHCHECK) —
      // ECS picks it up automatically without needing to be repeated here.
    });
    container.addPortMappings({ containerPort: 4100 });

    // X-Ray tracing + CloudWatch Application Signals — see otel-sidecar.ts.
    // Chosen as the first (Phase 0) service to instrument: smallest task
    // def (already being bumped for this anyway), already has an ALB
    // target group so a service map/RED metrics show up immediately, and
    // the simplest dependency graph of the 4 Node services (Redis pub/sub
    // only, no SQS/Kafka hop to validate trace continuity across yet).
    addCloudWatchAgentSidecar(this, taskDefinition, 'analytics');

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      securityGroups: [props.appServiceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: 2,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 4100,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: { path: '/health' },
    });

    // Priority 5 — must win over BackendServiceStack's /api/* rule (priority
    // 10) since both prefixes start with /api/v1/, or every analytics
    // request would silently fall through to the backend and 404.
    new elbv2.ApplicationListenerRule(this, 'AnalyticsListenerRule', {
      listener: props.httpListener,
      priority: 5,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/v1/analytics/*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    const scaling = this.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 4 });
    scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 60 });

    // Not one of the original config/prometheus-rules.yml rules (analytics
    // was never a Prometheus scrape target — see docs/BACKGROUND_SERVICES.md)
    // but it has a real ALB target group, so a "no healthy targets" alarm is
    // cheap and worth having anyway.
    new cloudwatch.Alarm(this, 'ServiceDownAlarm', {
      alarmDescription: 'analytics has no healthy ALB targets',
      metric: targetGroup.metrics.healthyHostCount({ period: cdk.Duration.minutes(1), statistic: 'Minimum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }).addAlarmAction(new cwActions.SnsAction(props.alertsTopic));

    new cdk.CfnOutput(this, 'ServiceName', { value: this.service.serviceName });
  }
}
