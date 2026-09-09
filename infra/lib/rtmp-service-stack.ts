import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

import { grantMskClientAccess } from './msk-iam-policy';

export interface RtmpServiceStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  httpListener: elbv2.ApplicationListener;
  albSecurityGroup: ec2.ISecurityGroup;
  /** Same shared SG as the Fargate services — reused here only for the DB
   * ingress grant DatabaseStack already made against it, matching
   * WsSfuStack's identical use of the same prop for the same reason. */
  appServiceSecurityGroup: ec2.ISecurityGroup;
  dbInstance: rds.IDatabaseInstance;
  dbSecret: secretsmanager.ISecret;

  /** The same bucket MediaStack already uses for post images/video — live
   * HLS output is written under a `live/<streamKey>/` prefix in this same
   * bucket rather than a new one, the same "reuse over parallel infra" call
   * already made repeatedly for this feature (see LiveStreamService's own
   * doc). The matching CloudFront cache behavior for the live manifest is
   * registered directly on MediaStack's own Distribution (see its doc
   * comment) rather than from here, to avoid a cross-stack CloudFormation
   * dependency cycle — this stack only needs the bucket to upload into and
   * the domain name to build the public playback URL. */
  mediaBucket: s3.IBucket;
  mediaCloudFrontDomain: string;

  /** The same shared Redis cluster the backend already reaches from this
   * exact instance's own `appServiceSecurityGroup` (CacheStack's ingress
   * rule is scoped to that SG, already attached below for the DB grant) —
   * read-only, for the peak-concurrent-viewer count LiveViewerPresenceServiceImpl
   * writes there (see rtmp/src/live_viewers.rs). No new security-group rule
   * needed for this reuse. */
  redisCluster: elasticache.CfnCacheCluster;

  /** Optional so this stack deploys fine before EventStreamingStack exists —
   * same graceful-degradation shape as BackendServiceStack's identical prop.
   * When absent, the rtmp process's warehouse::WarehouseEventPublisher is
   * entirely inert (see that module's own doc): a stream ending via encoder
   * disconnect just never gets a live.ended event, same as today. */
  mskClusterArn?: string;

  /** Where this stack's alarm notifies — see MonitoringStack. */
  alertsTopic: sns.ITopic;
}

/**
 * `rtmp` (the live-streaming RTMP ingest server) on EC2, not Fargate — the
 * exact same reasoning as `WsSfuStack`, applied to a different protocol: an
 * RTMP encoder (OBS, ffmpeg) needs a single stable public TCP port (1935)
 * to connect to directly, and Fargate's awsvpc networking has no
 * straightforward way to hand a task a fixed public IP the way an EC2
 * instance + Elastic IP does. Every other tier in this app is stateless/
 * queue-driven and runs on Fargate; this one, like `ws-sfu`, is neither.
 *
 * Unlike `ws-sfu`, there is no Cognito-authenticated signaling channel to
 * route through the ALB — the RTMP protocol on port 1935 is the entire
 * ingest surface, authenticated by stream key (validated directly against
 * Postgres, see rtmp/src/store/postgres.rs), not a JWT. What *does* go
 * through the shared ALB is this service's own small HTTP server (see
 * rtmp/src/http.rs): `/health` for the target group's own health check, and
 * `/hls/*` serving this instance's local-disk live HLS output — kept as a
 * same-instance fallback/testing path even now that real delivery exists
 * (below), since it's already there and costs nothing extra to leave
 * routed.
 *
 * Real delivery: the rtmp process itself uploads its live HLS output
 * (manifest + fMP4 segments) to MediaStack's existing S3 bucket under a
 * `live/<streamKey>/` prefix as it's produced (see rtmp/src/s3_sync.rs),
 * served through that same bucket's existing CloudFront distribution — see
 * MediaStack's own doc comment for the short-TTL manifest cache behavior,
 * which is registered there rather than here to avoid a cross-stack
 * dependency cycle.
 *
 * Also reaches two more shared stores directly, both read-only and both
 * best-effort (see rtmp/src/live_viewers.rs and rtmp/src/warehouse.rs): the
 * same Redis cluster the backend uses (for the peak-concurrent-viewer count
 * LiveViewerPresenceServiceImpl maintains there) and, when mskClusterArn is
 * configured, the same MSK cluster the backend publishes warehouse events
 * to — closing the one gap earlier phases explicitly left open: a stream
 * that ends via the encoder simply disconnecting (crash, network drop)
 * previously flipped Postgres's `live_status` correctly but never published
 * a `live.ended` event, since only the backend's own explicit "End Stream"
 * endpoint did. Both this instance's existing `appServiceSecurityGroup`
 * membership (for the DB grant above) and the new `producer`-role MSK IAM
 * grant below are what make these reachable — no new security-group rule
 * needed for Redis, since CacheStack's own ingress is already scoped to
 * that shared SG.
 *
 * Single instance, vertically scaled if needed later — same "Option A
 * first" precedent as ADR-002 already established for `ws-sfu`, and for
 * the same underlying reason: this service's own ffmpeg step is a `-c copy`
 * remux (no re-encoding), genuinely lighter than mediasoup's per-connection
 * SFU work, so a much smaller instance than `ws-sfu`'s is the honest
 * starting point here, not a corner cut.
 */
export class RtmpServiceStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: RtmpServiceStackProps) {
    super(scope, id, props);

    // Builds from the Dockerfile at deploy time, same asset-build approach
    // as every other service here (including WsSfuStack's identical use of
    // DockerImageAsset for the same "EC2, not Fargate" reason).
    const image = new ecrAssets.DockerImageAsset(this, 'RtmpImage', {
      directory: '../rtmp',
    });

    const securityGroup = new ec2.SecurityGroup(this, 'RtmpSecurityGroup', {
      vpc: props.vpc,
      description: 'escld rtmp — RTMP ingest (1935) public (any encoder, anywhere), HTTP (4001) from the ALB only',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(1935),
      'RTMP publish — encoders (OBS, ffmpeg) connect directly, cannot go through the ALB',
    );
    securityGroup.addIngressRule(props.albSecurityGroup, ec2.Port.tcp(4001), 'Health check + local HLS serving from the ALB');

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    image.repository.grantPull(role);
    props.dbSecret.grantRead(role);
    // Write-only — this process only ever uploads its own HLS output, never
    // reads anything back from the bucket (matches WsSfuStack's identical
    // write-only grant for call recordings, for the same reason).
    props.mediaBucket.grantPut(role, 'live/*');
    if (props.mskClusterArn) {
      grantMskClientAccess(this, role, props.mskClusterArn, 'producer');
    }

    // Same reasoning as WsSfuStack's LogGroup — this instance runs a bare
    // `docker run`, not the ECS awsLogs driver, so without an explicit log
    // group + this permission its stdout never reaches CloudWatch at all.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/escld/rtmp',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    logGroup.grantWrite(role);

    const eip = new ec2.CfnEIP(this, 'RtmpEip');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'dnf install -y docker jq',
      'systemctl enable --now docker',
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
      `docker pull ${image.imageUri}`,
      `SECRET=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${props.dbSecret.secretArn} --query SecretString --output text)`,
      'DB_USER=$(echo "$SECRET" | jq -r .username)',
      'DB_PASSWORD=$(echo "$SECRET" | jq -r .password)',
      // --network host: matches WsSfuStack's identical choice — this
      // service has no per-port Docker NAT/proxy need either, and it keeps
      // the container's own published port numbers identical to what's
      // configured below with zero translation to reason about.
      [
        'docker run -d --name rtmp --network host --restart unless-stopped',
        '--log-driver awslogs',
        `--log-opt awslogs-region=${this.region}`,
        `--log-opt awslogs-group=${logGroup.logGroupName}`,
        '--log-opt awslogs-create-group=false',
        '--log-opt awslogs-stream=rtmp',
        '-e PORT=1935',
        `-e AWS_REGION=${this.region}`,
        `-e DB_HOST=${props.dbInstance.dbInstanceEndpointAddress}`,
        `-e DB_PORT=${props.dbInstance.dbInstanceEndpointPort}`,
        '-e DB_NAME=escld',
        '-e DB_USER="$DB_USER"',
        '-e DB_PASSWORD="$DB_PASSWORD"',
        '-e DB_SSL=true',
        `-e LIVE_BUCKET_NAME=${props.mediaBucket.bucketName}`,
        '-e LIVE_BUCKET_PREFIX=live',
        `-e REDIS_HOST=${props.redisCluster.attrRedisEndpointAddress}`,
        `-e REDIS_PORT=${props.redisCluster.attrRedisEndpointPort}`,
        ...(props.mskClusterArn ? [`-e KAFKA_CLUSTER_ARN=${props.mskClusterArn}`] : []),
        image.imageUri,
      ].join(' '),
    );

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // A `-c copy` FLV->HLS remux per active stream is genuinely light
      // (no video re-encoding) — this is a deliberately small starting
      // point, not WsSfuStack's C6I.XLARGE, matching the CPU-cost
      // difference described in the class doc. Bump vertically first (same
      // ADR-002 precedent) once real concurrent-stream data says otherwise.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup,
      role,
      userData,
      userDataCausesReplacement: true,
    });
    // Second security group, granting the Postgres access DatabaseStack
    // already opened up for this shared SG — same pattern as WsSfuStack
    // (ec2.Instance only takes one SG at construction time).
    this.instance.addSecurityGroup(props.appServiceSecurityGroup);

    new ec2.CfnEIPAssociation(this, 'RtmpEipAssociation', {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 4001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new elbv2Targets.InstanceIdTarget(this.instance.instanceId, 4001)],
      healthCheck: { path: '/health' },
    });

    // /hls/* — this instance's own local-disk live HLS output, kept as a
    // same-instance fallback (see the class doc). The *real* delivery path
    // is the CloudFront behavior added below.
    new elbv2.ApplicationListenerRule(this, 'HlsListenerRule', {
      listener: props.httpListener,
      priority: 4,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/hls/*'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: eip.ref,
      description: 'Stable public IP RTMP encoders publish to (rtmp://<this>:1935/live/<streamKey>)',
    });
    new cdk.CfnOutput(this, 'LiveHlsUrlPattern', {
      value: `https://${props.mediaCloudFrontDomain}/live/<streamKey>/live.m3u8`,
      description: 'The real (CloudFront-backed) URL pattern a live stream is watchable at',
    });

    this.buildAlarms(targetGroup, props.alertsTopic);
  }

  private buildAlarms(targetGroup: elbv2.ApplicationTargetGroup, alertsTopic: sns.ITopic): void {
    new cloudwatch.Alarm(this, 'ServiceDownAlarm', {
      alarmDescription: 'rtmp has no healthy ALB targets',
      metric: targetGroup.metrics.healthyHostCount({ period: cdk.Duration.minutes(1), statistic: 'Minimum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
    }).addAlarmAction(new cwActions.SnsAction(alertsTopic));
  }
}
