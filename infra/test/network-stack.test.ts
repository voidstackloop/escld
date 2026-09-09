import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';

test('creates a VPC with public, private-egress, and isolated subnets across 2 AZs', () => {
  const app = new cdk.App();
  const stack = new NetworkStack(app, 'TestNetworkStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::VPC', 1);
  // 3 subnet tiers x 2 AZs
  template.resourceCountIs('AWS::EC2::Subnet', 6);
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
});
