import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

/**
 * The ECS Fargate cluster + ALB landing pad — Phase 1 of the 100k-DAU scaling
 * plan. Deliberately stops here: it stands up a real, deployable piece of
 * infra on its own (cluster + internet-facing ALB with a placeholder 404
 * default route), but doesn't yet define the backend/feed-worker/etc. Fargate
 * services and target groups — that's Phase 2, once each service's env wiring
 * (RDS/DynamoDB/Redis/Cognito) has somewhere real to point at. Wiring a
 * half-configured ECS service now (no image, no health check path, no env
 * vars) would just fail on first deploy.
 */
export class ComputeStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly httpListener: elbv2.ApplicationListener;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  /**
   * The backend Fargate service's security group, created here rather than in
   * any of them. Shared across every ECS service (backend, worker, feed-worker,
   * analytics) rather than one SG per service: DatabaseStack/CacheStack need
   * to add ingress rules against it (Postgres/Redis <- app tier), and each
   * service stack needs to read RDS/Redis endpoints from DatabaseStack/
   * CacheStack — creating a service's SG inside its own stack would make
   * DatabaseStack/CacheStack depend on that service stack while the service
   * stack simultaneously depends on them, a cyclic stack dependency CDK
   * rejects at synth time. Owning it here, in a stack nothing else depends
   * on, breaks the cycle for every consumer at once.
   */
  public readonly appServiceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'escld',
      vpc: props.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      // Private DNS namespace (Cloud Map) — services with no ALB in front
      // (Elasticsearch in SearchStack) still need a stable address other
      // services can reach them at; a bare Fargate task's IP changes on
      // every restart. Backend/feed-worker resolve it as
      // elasticsearch.escld.local.
      defaultCloudMapNamespace: { name: 'escld.local', vpc: props.vpc },
    });

    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'escld ALB - inbound 80/443 from the internet, outbound to ECS tasks',
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from the internet');
    this.albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from the internet');

    this.appServiceSecurityGroup = new ec2.SecurityGroup(this, 'AppServiceSecurityGroup', {
      vpc: props.vpc,
      description: 'escld app-tier Fargate tasks (backend, worker, feed-worker, analytics)',
      allowAllOutbound: true,
    });
    this.appServiceSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(8080), 'Backend API traffic from the ALB');
    this.appServiceSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(9090),
      'Backend ALB health-check probe (VPC-internal only, never a public listener)',
    );
    this.appServiceSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(4100), 'Analytics API traffic from the ALB');

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: 'escld',
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: this.albSecurityGroup,
    });

    // Placeholder default route — Phase 2 adds path-based rules (e.g. /api/*
    // to the backend target group) ahead of this in listener priority.
    this.httpListener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'No service registered for this path yet',
      }),
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'Point DNS (or the frontend API base URL) at this once Phase 2 services are live',
    });
  }
}
