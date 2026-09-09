import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * MSK's IAM action namespace (kafka-cluster:*) is scoped per resource type —
 * cluster/topic/group each have their own ARN shape sharing the same
 * clusterName/clusterUuid pair (see AWS's MSK IAM-access-control docs) — but
 * `EventStreamingStack.cluster.attrArn` is a deploy-time CDK token, so the
 * topic/group ARN patterns below can't be built with plain string
 * concatenation. `cdk.Arn.split` parses the token's `clusterName/clusterUuid`
 * resource name out from the cluster ARN so the topic/group patterns can be
 * rebuilt correctly regardless of what the actual values turn out to be.
 *
 * Shared between BackendServiceStack (producer) and BqSinkServiceStack
 * (consumer) rather than duplicated — the two need different data actions
 * (WriteData vs. ReadData+group access) but identical ARN-pattern plumbing.
 */
export function grantMskClientAccess(
  stack: cdk.Stack,
  taskRole: iam.IRole,
  clusterArn: string,
  role: 'producer' | 'consumer',
): void {
  const parsed = cdk.Arn.split(clusterArn, cdk.ArnFormat.SLASH_RESOURCE_NAME);
  const clusterResourceName = parsed.resourceName!; // "{clusterName}/{clusterUuid}"
  const topicArnPattern = cdk.Arn.format(
    { service: 'kafka', resource: 'topic', resourceName: `${clusterResourceName}/*`, region: parsed.region, account: parsed.account },
    stack,
  );

  taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'MskGetBootstrapBrokers',
    actions: ['kafka:GetBootstrapBrokers'],
    resources: [clusterArn],
  }));

  taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'MskClusterConnect',
    actions: ['kafka-cluster:Connect', 'kafka-cluster:DescribeCluster'],
    resources: [clusterArn],
  }));

  const dataAction = role === 'producer' ? 'kafka-cluster:WriteData' : 'kafka-cluster:ReadData';
  taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'MskTopicAccess',
    // CreateTopic: both sides create topics idempotently at startup (see
    // WarehouseEventPublisher / bq-sink's kafka.ts) rather than relying on
    // deploy-time ordering between the two services.
    actions: ['kafka-cluster:CreateTopic', 'kafka-cluster:DescribeTopic', dataAction],
    resources: [topicArnPattern],
  }));

  if (role === 'consumer') {
    const groupArnPattern = cdk.Arn.format(
      { service: 'kafka', resource: 'group', resourceName: `${clusterResourceName}/*`, region: parsed.region, account: parsed.account },
      stack,
    );
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'MskConsumerGroupAccess',
      actions: ['kafka-cluster:AlterGroup', 'kafka-cluster:DescribeGroup'],
      resources: [groupArnPattern],
    }));
  }
}
