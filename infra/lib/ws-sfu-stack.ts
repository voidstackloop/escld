import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

import { grantMskClientAccess } from './msk-iam-policy';

export interface WsSfuStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  httpListener: elbv2.ApplicationListener;
  albSecurityGroup: ec2.ISecurityGroup;
  /** Same shared SG as the Fargate services — reused here only for the DB ingress grant DatabaseStack already made against it, not for anything Fargate-specific. */
  appServiceSecurityGroup: ec2.ISecurityGroup;
  dbInstance: rds.IDatabaseInstance;
  dbSecret: secretsmanager.ISecret;
  conversationsTable: dynamodb.ITable;
  /** Private bucket call recordings are uploaded to — write-only from here, see RecordingsStack. */
  recordingsBucket: s3.IBucket;
  cognitoIssuerUri: string;
  cognitoAppClientId: string;
  corsAllowedOrigins: string;

  /** Read-only — resolves a live streamer's followers for the Kafka-driven
   * feed push (see ws-sfu/src/store/social_graph.rs). Unlike
   * `conversationsTable`, ws-sfu never writes to this table; the Java
   * backend's `FollowGraphStore` remains the sole writer. */
  followsTable: dynamodb.ITable;

  /** Optional so this stack deploys fine before EventStreamingStack exists —
   * same graceful-degradation shape as BackendServiceStack's/
   * RtmpServiceStack's identical prop. When absent, ws-sfu's Kafka consumer
   * (see ws-sfu/src/kafka/mod.rs) is never even constructed: going live
   * still works, it just never pushes a real-time feed update. */
  mskClusterArn?: string;

  /** Where this stack's alarms notify — see MonitoringStack. */
  alertsTopic: sns.ITopic;
}

/**
 * `ws-sfu` on EC2, not Fargate — this is ADR-002's "Option A: keep scaling
 * vertically", made real. mediasoup needs a stable *public* IP for WebRTC
 * ICE candidates (MEDIASOUP_ANNOUNCED_IP) and a UDP port range clients
 * connect to directly (see ws-sfu/src/sfu/room.rs) — Fargate's awsvpc
 * networking has no straightforward path to a stable public IP the way an
 * EC2 instance + Elastic IP does, and Fargate's per-task ENI doesn't
 * comfortably front a 1000-port UDP range either. Every other tier in this
 * plan is stateless/queue-driven and runs on Fargate; this one is neither.
 *
 * WebSocket signaling (Socket.IO, default path /socket.io) is routed
 * through the shared ALB like every other service; the actual RTP media
 * never touches the ALB — it flows directly between the client and this
 * instance's Elastic IP over UDP 40000-40999, which is why that range has
 * to be open to the internet at the security-group level (there is no way
 * around that for a self-hosted SFU).
 *
 * The UDP range is sized for real headroom, not just today's traffic: every
 * mediasoup worker process (one per vCPU, see the MEDIASOUP_WORKER_COUNT
 * comment below) draws WebRTC transport ports from this *same* shared range
 * — mediasoup doesn't partition it per worker — so a range sized for a
 * single worker would silently cap total concurrent-transport capacity at
 * roughly ports/2 participants instance-wide regardless of how many worker
 * processes/vCPUs are thrown at it. 1000 ports is comfortable headroom for
 * this instance size; if the instance type grows well beyond
 * C6I.XLARGE, re-check this range (and the security-group rule and
 * docker-compose.yaml's published range) rather than assuming it still has
 * enough room.
 *
 * Horizontal scaling (ADR-002's Option B) is deliberately not built here —
 * see that record for why: stay on this single instance until
 * ROOMS_ACTIVE/SOCKETS_CONNECTED show a real ceiling, then spike Option C
 * (managed WebRTC) before committing to a multi-instance room-affinity
 * rebuild.
 */
export class WsSfuStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: WsSfuStackProps) {
    super(scope, id, props);

    // Builds from the existing pinned Dockerfile (rust:1.94-bookworm) at
    // deploy time, same asset-build approach as every Fargate service here.
    const image = new ecrAssets.DockerImageAsset(this, 'WsSfuImage', {
      directory: '../ws-sfu',
    });

    const securityGroup = new ec2.SecurityGroup(this, 'WsSfuSecurityGroup', {
      vpc: props.vpc,
      description: 'escld ws-sfu — signaling from the ALB only, WebRTC media UDP range public (no way around this for a self-hosted SFU)',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(props.albSecurityGroup, ec2.Port.tcp(4000), 'Socket.IO signaling from the ALB');
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udpRange(40000, 40999),
      'WebRTC media (RTP/RTCP) — clients connect directly, cannot go through the ALB',
    );

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    image.repository.grantPull(role);
    props.dbSecret.grantRead(role);
    props.conversationsTable.grantReadWriteData(role);
    // Read-only — see ws-sfu/src/store/social_graph.rs's own doc for why
    // this table's sole writer stays the Java backend.
    props.followsTable.grantReadData(role);
    // Write-only — ws-sfu uploads finished recordings but never reads one
    // back (see the class doc on RecordingsStack for why nothing can).
    props.recordingsBucket.grantPut(role);
    // 'consumer' — the first Rust *consumer* of this cluster (rtmp/'s own
    // grant, by contrast, is 'producer'). Reuses the exact same shared
    // helper RtmpServiceStack/BqSinkServiceStack already call.
    if (props.mskClusterArn) {
      grantMskClientAccess(this, role, props.mskClusterArn, 'consumer');
    }
    // X-Ray tracing, Phase 2 of the telemetry rollout — the standalone ADOT
    // Collector container below (not ecs-cwagent; this is EC2, not ECS)
    // needs this to actually export what it receives. Not covered by
    // AmazonSSMManagedInstanceCore above, same real gap already documented
    // for every ECS task role in otel-sidecar.ts.
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess'));

    // Unlike every other service here, this instance runs a bare `docker
    // run` (see below) rather than the ECS awsLogs driver, so without this
    // its stdout only ever reaches local instance disk — never CloudWatch.
    // Docker's own awslogs log driver (no separate CloudWatch agent needed)
    // handles shipping once given a log group + this permission.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/escld/ws-sfu',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    logGroup.grantWrite(role);

    const eip = new ec2.CfnEIP(this, 'WsSfuEip');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf install -y docker jq',
      'systemctl enable --now docker',
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      `docker pull ${image.imageUri}`,
      `SECRET=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${props.dbSecret.secretArn} --query SecretString --output text)`,
      'DB_USER=$(echo "$SECRET" | jq -r .username)',
      'DB_PASSWORD=$(echo "$SECRET" | jq -r .password)',
      // X-Ray tracing, Phase 2 — no ADOT distro exists for Rust (see
      // ws-sfu/Cargo.toml's comment on the hand-rolled tracing-opentelemetry
      // wiring), so instead of an ECS-style sidecar container this is a
      // second, standalone `docker run` on the same instance: AWS's own
      // ADOT Collector image, receiving OTLP/HTTP from ws-sfu on localhost
      // and exporting to X-Ray. Only the http protocol is enabled on the
      // receiver — ws-sfu never speaks OTLP/gRPC, no reason to open that
      // port too. `v0.50.0` verified as a real, currently-published tag
      // against the public ECR Gallery's own tags-list API before pinning
      // it, the same way otel-sidecar.ts's Java image tag was verified.
      `cat <<'EOF' > /etc/otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
processors:
  batch: {}
exporters:
  awsxray:
    region: ${this.region}
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [awsxray]
EOF`,
      [
        'docker run -d --name otel-collector --network host --restart unless-stopped',
        '-v /etc/otel-collector-config.yaml:/otel-local-config.yaml',
        '--log-driver awslogs',
        `--log-opt awslogs-region=${this.region}`,
        `--log-opt awslogs-group=${logGroup.logGroupName}`,
        '--log-opt awslogs-create-group=false',
        '--log-opt awslogs-stream=otel-collector',
        `-e AWS_REGION=${this.region}`,
        'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0',
        '--config', 'otel-local-config.yaml',
      ].join(' '),
      // --network host: mediasoup's UDP port range works exactly like a
      // bare process this way, no per-port Docker NAT/proxy needed — the
      // standard pattern for self-hosted mediasoup on a VM (see class doc).
      // Also lets ws-sfu reach the otel-collector container above over
      // localhost, same shared-network-namespace reasoning.
      [
        'docker run -d --name ws-sfu --network host --restart unless-stopped',
        '--log-driver awslogs',
        `--log-opt awslogs-region=${this.region}`,
        `--log-opt awslogs-group=${logGroup.logGroupName}`,
        '--log-opt awslogs-create-group=false',
        '--log-opt awslogs-stream=ws-sfu',
        '-e PORT=4000',
        `-e CORS_ALLOWED_ORIGINS="${props.corsAllowedOrigins}"`,
        `-e AWS_REGION=${this.region}`,
        `-e DYNAMODB_CONVERSATIONS_TABLE=${props.conversationsTable.tableName}`,
        `-e COGNITO_ISSUER_URI="${props.cognitoIssuerUri}"`,
        `-e COGNITO_APP_CLIENT_ID="${props.cognitoAppClientId}"`,
        `-e DB_HOST=${props.dbInstance.dbInstanceEndpointAddress}`,
        `-e DB_PORT=${props.dbInstance.dbInstanceEndpointPort}`,
        '-e DB_NAME=escld',
        '-e DB_USER="$DB_USER"',
        '-e DB_PASSWORD="$DB_PASSWORD"',
        '-e DB_SSL=true',
        // No MEDIASOUP_WORKER_COUNT here on purpose — ws-sfu/src/config.rs
        // defaults it to the container's own available_parallelism() (one
        // mediasoup worker per visible core), so it tracks the instance
        // type below automatically instead of needing to be hand-kept in
        // sync with it. Override only for deliberate, non-default tuning.
        '-e MEDIASOUP_LISTEN_IP=0.0.0.0',
        `-e MEDIASOUP_ANNOUNCED_IP=${eip.ref}`,
        '-e MEDIASOUP_RTC_MIN_PORT=40000',
        '-e MEDIASOUP_RTC_MAX_PORT=40999',
        `-e RECORDINGS_BUCKET=${props.recordingsBucket.bucketName}`,
        `-e DYNAMODB_FOLLOWS_TABLE=${props.followsTable.tableName}`,
        ...(props.mskClusterArn ? [`-e KAFKA_CLUSTER_ARN=${props.mskClusterArn}`] : []),
        '-e OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces',
        '-e OTEL_SERVICE_NAME=escld-ws-sfu',
        image.imageUri,
      ].join(' '),
    );

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // 4 vCPU — ws-sfu auto-sizes its mediasoup worker pool to whatever
      // this reports (see the MEDIASOUP_WORKER_COUNT comment above), so
      // scaling vertically per ADR-002 is just changing this one line.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.C6I, ec2.InstanceSize.XLARGE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      role,
      userData,
      userDataCausesReplacement: true,
    });
    // Second security group, granting the Postgres access DatabaseStack
    // already opened up for this shared SG (see DatabaseStack's ingress
    // rule) — ec2.Instance only takes one SG at construction time.
    this.instance.addSecurityGroup(props.appServiceSecurityGroup);

    new ec2.CfnEIPAssociation(this, 'WsSfuEipAssociation', {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new elbv2Targets.InstanceIdTarget(this.instance.instanceId, 4000)],
      healthCheck: { path: '/health' },
    });

    new elbv2.ApplicationListenerRule(this, 'SignalingListenerRule', {
      listener: props.httpListener,
      priority: 3,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/socket.io/*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: eip.ref,
      description: 'Stable public IP WebRTC clients connect to for media (also MEDIASOUP_ANNOUNCED_IP)',
    });

    this.buildAlarms(targetGroup, props.alertsTopic);
  }

  /** Native CloudWatch equivalents of config/prometheus-rules.yml's
   * ServiceDown and WsSfuAuthFailureSpike rules, the latter reading the EMF
   * counter ws-sfu's own emf.rs emits alongside its Prometheus metrics. */
  private buildAlarms(targetGroup: elbv2.ApplicationTargetGroup, alertsTopic: sns.ITopic): void {
    const notify = (alarm: cloudwatch.Alarm) => alarm.addAlarmAction(new cwActions.SnsAction(alertsTopic));

    notify(new cloudwatch.Alarm(this, 'ServiceDownAlarm', {
      alarmDescription: 'ws-sfu has no healthy ALB targets',
      metric: targetGroup.metrics.healthyHostCount({ period: cdk.Duration.minutes(1), statistic: 'Minimum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }));

    notify(new cloudwatch.Alarm(this, 'AuthFailureSpikeAlarm', {
      alarmDescription: 'ws-sfu rejecting connections at an elevated rate (>1 req/s, averaged over 5 minutes)',
      metric: new cloudwatch.Metric({
        namespace: 'escld/ws-sfu',
        metricName: 'ws_sfu_auth_failures_total',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1 * 300,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }));
  }
}
