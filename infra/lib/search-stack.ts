import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface SearchStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  appServiceSecurityGroup: ec2.ISecurityGroup;
  alertsTopic: sns.ITopic;
}

/**
 * Self-hosted Elasticsearch on Fargate, not managed AWS OpenSearch — this is
 * the resolution of the "real choice, not a given" the plan flagged for
 * Phase 4. Checked before building: the backend's own docker-compose.yaml
 * has a standing comment explaining that Spring Boot 4 bundles the
 * elasticsearch-java 9.x client, and matching the *server* major version to
 * that client avoids protocol mismatches. What that comment doesn't spell
 * out but matters more here: Elastic's official Java client (v8+) performs a
 * hard product-compatibility check on connect — an `X-Elastic-Product`
 * response header genuine Elasticsearch sends and AWS OpenSearch does not —
 * and refuses to operate against a cluster that fails it. The `@elastic/
 * elasticsearch` npm client (feed-worker) carries the same-generation check.
 * Migrating to OpenSearch would break both without also swapping those
 * client libraries for OpenSearch's own — a real application-code change,
 * not an infra swap. Self-hosting keeps the exact same client compatibility
 * the app already depends on.
 *
 * Single node (matches docker-compose's `discovery.type=single-node`) — a
 * real multi-node ES cluster needs dedicated master/data roles and shard
 * planning, out of scope here; this is the same "vertical/simple first"
 * choice this plan already made for ws-sfu and Redis. EFS gives it
 * persistent storage across task restarts/redeploys (Fargate has no local
 * persistent disk) — the one piece of this whole plan I could not verify
 * beyond template-level correctness without an actual deploy: the EFS
 * access point's POSIX uid/gid below (1000:0) is the documented elasticsearch
 * Docker image user, but only a real deploy proves the container can
 * actually write to the mounted volume with it.
 */
export class SearchStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SearchStackProps) {
    super(scope, id, props);

    this.securityGroup = new ec2.SecurityGroup(this, 'SearchSecurityGroup', {
      vpc: props.vpc,
      description: 'escld Elasticsearch — no auth (xpack.security disabled, matching dev), so this must stay app-tier-only, never public',
      allowAllOutbound: true,
    });
    this.securityGroup.addIngressRule(
      props.appServiceSecurityGroup,
      ec2.Port.tcp(9200),
      'App-tier Fargate tasks -> Elasticsearch',
    );

    const fileSystem = new efs.FileSystem(this, 'SearchData', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    fileSystem.connections.allowDefaultPortFrom(this.securityGroup, 'Fargate task -> EFS mount target (NFS)');

    const accessPoint = fileSystem.addAccessPoint('SearchDataAccessPoint', {
      path: '/elasticsearch-data',
      // Matches the official elasticsearch Docker image's runtime user
      // (uid 1000, gid 0) — see class doc above on why this is unverified.
      posixUser: { uid: '1000', gid: '0' },
      createAcl: { ownerUid: '1000', ownerGid: '0', permissions: '750' },
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      // Heap = ~50% of container memory is the standard ES sizing guideline
      // (see ES_JAVA_OPTS below) — Lucene relies on the OS file-system cache
      // for the rest, not the JVM heap.
      cpu: 1024,
      memoryLimitMiB: 2048,
      volumes: [
        {
          name: 'search-data',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
          },
        },
      ],
    });
    fileSystem.grantRootAccess(taskDefinition.taskRole);

    const container = taskDefinition.addContainer('elasticsearch', {
      image: ecs.ContainerImage.fromRegistry('docker.elastic.co/elasticsearch/elasticsearch:9.4.3'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'elasticsearch' }),
      environment: {
        'discovery.type': 'single-node',
        'xpack.security.enabled': 'false',
        ES_JAVA_OPTS: '-Xms1024m -Xmx1024m',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -sf http://localhost:9200/_cluster/health || exit 1'],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        retries: 20,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
    container.addPortMappings({ containerPort: 9200 });
    container.addMountPoints({
      containerPath: '/usr/share/elasticsearch/data',
      sourceVolume: 'search-data',
      readOnly: false,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition,
      securityGroups: [this.securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      // Single node by design (see class doc) — do not raise this without
      // first giving Elasticsearch real multi-node cluster configuration.
      desiredCount: 1,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // Resolves as elasticsearch.escld.local within the VPC (namespace
      // created on the cluster in ComputeStack) — the stable address
      // BackendServiceStack/FeedWorkerServiceStack point SPRING_ELASTICSEARCH_URIS
      // / ELASTICSEARCH_URL at.
      cloudMapOptions: { name: 'elasticsearch' },
    });

    // No ALB (service discovery is via Cloud Map, not a load balancer — see
    // above), and this was previously an explicitly-deferred gap in the
    // telemetry plan ("would need touching SearchStack"). Same RunningTaskCount-
    // via-ECS-Container-Insights pattern already used for BqSinkServiceStack/
    // TranscodeWorkerServiceStack/FeedWorkerServiceStack's own ServiceDownAlarms —
    // arguably the highest-value of the four, since this is the single-node
    // (no redundancy) store every search query and feed-ranking request depends on.
    new cloudwatch.Alarm(this, 'ServiceDownAlarm', {
      alarmDescription: 'Elasticsearch has zero running tasks',
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
