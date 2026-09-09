import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';

test('creates a Fargate cluster with an internet-facing ALB', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'TestNetworkStack');
  const stack = new ComputeStack(app, 'TestComputeStack', { vpc: network.vpc });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::ECS::Cluster', {
    ClusterName: 'escld',
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
  });
});

test('the default listener returns a placeholder 404 until Phase 2 registers real target groups', () => {
  const app = new cdk.App();
  const network = new NetworkStack(app, 'TestNetworkStack2');
  const stack = new ComputeStack(app, 'TestComputeStack2', { vpc: network.vpc });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 80,
    DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
  });
});
