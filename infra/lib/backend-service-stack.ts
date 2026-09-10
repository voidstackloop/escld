import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { grantMskClientAccess } from './msk-iam-policy';
import { addCloudWatchAgentSidecar, addJavaAdotInitContainer, JAVA_ADOT_AGENT_FLAG, otelEnvVars } from './otel-sidecar';

export interface BackendServiceStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  httpListener: elbv2.ApplicationListener;
  /**
   * Created in ComputeStack, not here — see that stack's comment on the field
   * for why (avoids a cyclic stack dependency: DatabaseStack/CacheStack need
   * to grant this SG ingress, while this stack needs to read DatabaseStack/
   * CacheStack's endpoints).
   */
  appServiceSecurityGroup: ec2.ISecurityGroup;

  dbInstance: rds.IDatabaseInstance;
  dbSecret: secretsmanager.ISecret;

  redisCluster: elasticache.CfnCacheCluster;

  followsTable: dynamodb.ITable;
  feedTable: dynamodb.ITable;
  conversationsTable: dynamodb.ITable;
  moderationTable: dynamodb.ITable;
  likesTable: dynamodb.ITable;
  postHidesTable: dynamodb.ITable;
  domainOutboxTable: dynamodb.ITable;
  /** Materialized daily insights bq-sink's exporter writes — see
   * insights-stack.ts. Read-only for the backend; bq-sink is the sole
   * writer. */
  insightsTable: dynamodb.ITable;

  transcodeQueue: sqs.IQueue;
  postEventsQueue: sqs.IQueue;

  mediaBucket: s3.IBucket;
  mediaCloudFrontDomain: string;

  /**
   * Elasticsearch endpoint the backend's Spring Data Elasticsearch repositories
   * (PostSearchRepository/UserSearchRepository) connect to — SearchStack's
   * Cloud Map DNS name (http://elasticsearch.escld.local:9200), passed as a
   * plain string rather than a cross-stack construct reference since Cloud
   * Map names are deterministic (see bin/infra.ts). Kept as an explicit prop
   * rather than a hardcoded default so the dependency stays visible here.
   */
  elasticsearchUri: string;

  corsAllowedOrigins: string;
  cognitoIssuerUri: string;
  cognitoAppClientId: string;

  /** Where this stack's alarms notify — see MonitoringStack. */
  alertsTopic: sns.ITopic;

  /** Optional so the backend deploys fine before EventStreamingStack exists
   * or while it's being stood up — KafkaConfig's producer bean is entirely
   * skipped (app.kafka.enabled=false) when this is absent, see that class's
   * doc comment. */
  mskClusterArn?: string;
}

/**
 * The backend Fargate service — Phase 2 of the 100k-DAU plan, the first
 * real workload on top of Phase 1's cluster/ALB/RDS. Scoped to just the
 * Spring Boot API; feed-worker/worker/analytics/ws-sfu follow the same
 * SQS-consumer or WebSocket-service shape and are a fast follow once this
 * one is confirmed working end-to-end.
 */
export class BackendServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: BackendServiceStackProps) {
    super(scope, id, props);

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      // 1 vCPU / 3GB — memory bumped from 2GB for Phase 1 of the X-Ray/
      // Application Signals rollout (see otel-sidecar.ts): the JVM's own
      // -Xmx1536m+MaxMetaspaceSize192m already used most of a 2GB task,
      // leaving too little room for the added ecs-cwagent sidecar's 256MB
      // reservation plus the brief window where the otel-java-init container
      // also holds memory before exiting — verified this was a real,
      // forced change (not optional) by adding up the worst case, the same
      // way analytics-service-stack.ts's Fargate-floor bump was justified.
      cpu: 1024,
      memoryLimitMiB: 3072,
      executionRole,
    });

    props.dbSecret.grantRead(taskDefinition.taskRole);
    for (const table of [
      props.followsTable,
      props.feedTable,
      props.conversationsTable,
      props.moderationTable,
      props.likesTable,
      props.postHidesTable,
      props.domainOutboxTable,
    ]) {
      table.grantReadWriteData(taskDefinition.taskRole);
    }
    // Read-only: bq-sink's insights-export.ts is this table's sole writer.
    props.insightsTable.grantReadData(taskDefinition.taskRole);
    props.transcodeQueue.grantSendMessages(taskDefinition.taskRole);
    props.postEventsQueue.grantSendMessages(taskDefinition.taskRole);
    // Backend issues presigned PUT/GET URLs (see PresignedUploadRequest) that
    // the *client* later uses directly against S3 — the task role's own
    // credentials are what those presigned URLs are signed with.
    props.mediaBucket.grantReadWrite(taskDefinition.taskRole);
    if (props.mskClusterArn) {
      grantMskClientAccess(this, taskDefinition.taskRole, props.mskClusterArn, 'producer');
    }

    const dbUrl = `jdbc:postgresql://${props.dbInstance.dbInstanceEndpointAddress}:${props.dbInstance.dbInstanceEndpointPort}/escld`;

    // Explicit LogGroup + retention — without this, the awsLogs driver
    // auto-creates an unmanaged group that defaults to "Never Expire", which
    // is a real cost/hygiene gap at this log volume (com.escld.backend logs
    // at DEBUG by default, see application.yml). Not the source of truth for
    // anything (the audit trail lives in DynamoDB, see ModerationStore), so
    // DESTROY on stack teardown is correct here, not RETAIN.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/escld/backend',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const feedCursorSigningKey = new secretsmanager.Secret(this, 'FeedCursorSigningKey', {
      description: 'HMAC key for viewer-bound feed snapshot cursors',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    const container = taskDefinition.addContainer('backend', {
      image: ecs.ContainerImage.fromAsset('../backend'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'backend', logGroup }),
      environment: {
        SPRING_DOCKER_COMPOSE_ENABLED: 'false',
        // Turns on Spring Boot's structured JSON logging (already built,
        // previously dormant — see application.yml's logging.structured
        // block) so log lines are queryable in CloudWatch Logs Insights
        // instead of grep'd out of plain text.
        LOG_FORMAT: 'ecs',
        SPRING_DATASOURCE_URL: dbUrl,
        SPRING_DATA_REDIS_HOST: props.redisCluster.attrRedisEndpointAddress,
        SPRING_DATA_REDIS_PORT: props.redisCluster.attrRedisEndpointPort,
        SPRING_ELASTICSEARCH_URIS: props.elasticsearchUri,
        AWS_REGION: this.region,
        MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
        MEDIA_BUCKET_REGION: this.region,
        MEDIA_CLOUDFRONT_DOMAIN: props.mediaCloudFrontDomain,
        DYNAMODB_FOLLOWS_TABLE: props.followsTable.tableName,
        DYNAMODB_FEED_TABLE: props.feedTable.tableName,
        DYNAMODB_MODERATION_TABLE: props.moderationTable.tableName,
        DYNAMODB_LIKES_TABLE: props.likesTable.tableName,
        DYNAMODB_POST_HIDES_TABLE: props.postHidesTable.tableName,
        DYNAMODB_DOMAIN_OUTBOX_TABLE: props.domainOutboxTable.tableName,
        DYNAMODB_INSIGHTS_TABLE: props.insightsTable.tableName,
        SQS_TRANSCODE_QUEUE_URL: props.transcodeQueue.queueUrl,
        SQS_POST_EVENTS_QUEUE_URL: props.postEventsQueue.queueUrl,
        CORS_ALLOWED_ORIGINS: props.corsAllowedOrigins,
        COGNITO_ISSUER_URI: props.cognitoIssuerUri,
        COGNITO_APP_CLIENT_ID: props.cognitoAppClientId,
        // -javaagent appended here (not passed separately) — JAVA_TOOL_OPTIONS
        // is a single env var, and addJavaAdotInitContainer below only wires
        // the filesystem/volume side, not this string. See otel-sidecar.ts
        // for why Java's ADOT wiring needs an init container at all, unlike
        // Node's NODE_OPTIONS-only approach in analytics-service-stack.ts.
        // MaxMetaspaceSize is 384m, not the 192m this ran with before Phase 1:
        // 192m was sized for a plain Spring Boot app, and the ADOT javaagent
        // added here instruments Spring/Tomcat/JDBC/Lettuce/Kafka/Elasticsearch/
        // the AWS SDK, generating enough extra loaded classes to exhaust it.
        // A real deploy died with "OutOfMemoryError: Metaspace" once traffic
        // hit it — and because a metaspace-starved JVM can't load new classes,
        // the failure surfaced as the Redis/Elasticsearch health indicators
        // throwing, so /actuator/health reported DOWN and every task was
        // pulled from the load balancer while the app itself still served
        // requests. Budget at 3072 task MiB: 1536 heap + 384 metaspace +
        // ~350 JVM overhead + the sidecar's 256 reservation still leaves room.
        JAVA_TOOL_OPTIONS: `-Xmx1536m -XX:MaxMetaspaceSize=384m ${JAVA_ADOT_AGENT_FLAG}`,
        ...otelEnvVars('escld-backend'),
        ...(props.mskClusterArn
          ? { KAFKA_ENABLED: 'true', KAFKA_CLUSTER_ARN: props.mskClusterArn }
          : {}),
      },
      secrets: {
        SPRING_DATASOURCE_USERNAME: ecs.Secret.fromSecretsManager(props.dbSecret, 'username'),
        SPRING_DATASOURCE_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, 'password'),
        FEED_CURSOR_SIGNING_KEY: ecs.Secret.fromSecretsManager(feedCursorSigningKey),
      },
      // A /dev/tcp raw-socket probe, because the eclipse-temurin JRE base
      // image ships neither curl nor wget.
      //
      // 'CMD' + an explicit 'bash', NOT 'CMD-SHELL': ECS runs a CMD-SHELL
      // string through /bin/sh, and /bin/sh in eclipse-temurin:25-jre is a
      // symlink to dash, which does not implement /dev/tcp at all (verified
      // by running the real image: "sh: cannot create /dev/tcp/...:
      // Directory nonexistent"). Under CMD-SHELL this probe could therefore
      // never pass however healthy the app was, so ECS marked every task
      // UNHEALTHY and replaced it forever. /dev/tcp is a bash builtin and
      // bash is present at /usr/bin/bash, so invoking it explicitly is the
      // fix. Do not "simplify" this back to CMD-SHELL.
      healthCheck: {
        command: [
          'CMD',
          'bash',
          '-c',
          'exec 3<>/dev/tcp/127.0.0.1/9090 && printf \'GET /actuator/health HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n\' >&3 && grep -q \'"status":"UP"\' <&3',
        ],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        retries: 10,
        // Measured against a real deploy: this container reaches "Started
        // BackendApplication" ~85s after its first log line (JVM + the ADOT
        // javaagent's class-loading + Spring context + Flyway). A 30s
        // startPeriod meant the probe spent ~55s of that boot burning
        // retries for no reason.
        startPeriod: cdk.Duration.seconds(120),
      },
    });
    container.addPortMappings(
      { containerPort: 8080 },
      // Not exposed through the ALB listener (see ComputeStack) — only reached
      // by the ALB's own health-check probe and the ECS agent, both
      // VPC-internal. Never add a public listener rule pointing at this port.
      { containerPort: 9090 },
    );

    // X-Ray tracing + CloudWatch Application Signals, Phase 1 of the
    // rollout begun in analytics-service-stack.ts (Phase 0) — see
    // otel-sidecar.ts for the shared ecs-cwagent sidecar/IAM wiring and why
    // Java additionally needs the init-container/volume dance Node doesn't.
    addCloudWatchAgentSidecar(this, taskDefinition, 'backend');
    addJavaAdotInitContainer(taskDefinition, container);

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      securityGroups: [props.appServiceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // 2 minimum for HA across AZs even at idle; the plan's load estimate
      // (~350-450 req/s peak) targets 4-8 under the CPU-based autoscaling below.
      desiredCount: 2,
      circuitBreaker: { rollback: true },
      // Default is 50/200 — a rolling deploy would drop as low as 1 running
      // task. 100/200 keeps full capacity up throughout every deploy instead.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // CDK defaults this to 60s the moment a load balancer target is
      // attached, which is shorter than this app's own boot: a real deploy
      // measured 83-85s from container start to a serving /actuator/health,
      // while the ALB declares a fresh target unhealthy after 2 failed
      // checks (2 x 30s = 60s). The grace period expired ~25s before the
      // app could ever answer, so ECS killed every task mid-boot and the
      // service crash-looped forever with a perfectly healthy application.
      // 240s leaves real headroom over the measured 85s for a cold start.
      healthCheckGracePeriod: cdk.Duration.seconds(240),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        // Every API path requires JWT auth (see SecurityConfig) — health-checking
        // the actuator port instead of a public 8080 path avoids either adding
        // an auth-exempt endpoint just for this or accepting 401s as "healthy".
        port: '9090',
        path: '/actuator/health',
        healthyHttpCodes: '200',
        // Explicit, not the ALB defaults (30s interval / 5 healthy / 2
        // unhealthy), because those defaults interact badly with an ~85s JVM
        // boot in both directions:
        //   - going healthy took 5 x 30s = 150s AFTER boot, i.e. ~235s from
        //     task start, which barely fits inside the grace period above and
        //     left no margin for a slow ECR pull or a busy host.
        //   - going unhealthy took only 2 x 30s = 60s, so one blip in a shared
        //     dependency could yank every task out of service at once.
        // 15s/2 reaches healthy ~30s after boot (~115s total, comfortably
        // inside the grace period) while 5 failures now need 75s, making a
        // transient stumble less likely to cascade into a full outage.
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    // Ahead of ComputeStack's placeholder 404 default action in priority.
    this.httpListenerRule(props.httpListener, targetGroup);

    const scaling = this.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 8 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
    scaling.scaleOnRequestCount('RequestCountScaling', {
      requestsPerTarget: 500,
      targetGroup,
    });

    this.buildAlarms(targetGroup, props.alertsTopic);

    new cdk.CfnOutput(this, 'ServiceName', { value: this.service.serviceName });
  }

  private httpListenerRule(listener: elbv2.ApplicationListener, targetGroup: elbv2.ApplicationTargetGroup): void {
    new elbv2.ApplicationListenerRule(this, 'ApiListenerRule', {
      listener,
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });
  }

  /** Native CloudWatch equivalents of config/prometheus-rules.yml's
   * escld-backend rule group — see docs/telemetry plan for the mapping
   * reasoning. RateLimitSaturation uses the EMF counter RateLimitFilter now
   * emits (§2 of the plan); HighJvmHeapUsage substitutes ECS/Container
   * Insights container memory for true JVM heap (no scheduled heap-sampling
   * task exists to EMF-emit that yet — a reasonable proxy, not the original
   * exact signal, flagged here rather than silently swapped in). */
  private buildAlarms(targetGroup: elbv2.ApplicationTargetGroup, alertsTopic: sns.ITopic): void {
    const notify = (alarm: cloudwatch.Alarm) => alarm.addAlarmAction(new cwActions.SnsAction(alertsTopic));

    notify(new cloudwatch.Alarm(this, 'ServiceDownAlarm', {
      alarmDescription: 'Backend has no healthy ALB targets',
      metric: targetGroup.metrics.healthyHostCount({ period: cdk.Duration.minutes(1), statistic: 'Minimum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }));

    const requestCount = targetGroup.metrics.requestCount({ period: cdk.Duration.minutes(5), statistic: 'Sum' });
    const errorCount = targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    });
    notify(new cloudwatch.Alarm(this, 'HighErrorRateAlarm', {
      alarmDescription: 'Backend 5xx rate above 5% over 5 minutes',
      metric: new cloudwatch.MathExpression({
        // Guards divide-by-zero on idle periods. NOT `MAX([requests, 1])`:
        // CloudWatch's MAX() reduces one time series to a scalar, it is not an
        // element-wise max over two operands, so that form is rejected at
        // alarm-creation time with "Unsupported operand type(s) for MAX:
        // [Array[TimeSeries, Scalar]]". IF() is the construct that actually
        // does per-datapoint branching — no requests in a period reads as a
        // 0% error rate rather than a gap.
        expression: 'IF(requests > 0, errors / requests, 0)',
        usingMetrics: { errors: errorCount, requests: requestCount },
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0.05,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }));

    notify(new cloudwatch.Alarm(this, 'HighP99LatencyAlarm', {
      alarmDescription: 'Backend p99 response time above 2s',
      metric: targetGroup.metrics.targetResponseTime({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
      threshold: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }));

    notify(new cloudwatch.Alarm(this, 'RateLimitSaturationAlarm', {
      alarmDescription: 'Sustained rate-limit throttling (>5 req/s rejected, averaged over 5 minutes)',
      metric: new cloudwatch.Metric({
        namespace: 'escld/backend',
        metricName: 'rate_limit_rejections_total',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5 * 300,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }));

    notify(new cloudwatch.Alarm(this, 'HighContainerMemoryAlarm', {
      alarmDescription: 'Backend container memory above 90% for 10 minutes (JVM heap proxy — see class doc)',
      metric: this.service.metricMemoryUtilization({ period: cdk.Duration.minutes(10), statistic: 'Average' }),
      threshold: 90,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }));
  }
}
