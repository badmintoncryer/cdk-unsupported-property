/* eslint-disable import/no-unresolved */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class TestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 通常のプロパティ指定方法
    new cdk.aws_cloudfront.CfnDistribution(this, 'NormalProps', {
      distributionConfig: {
        enabled: true,
        defaultCacheBehavior: {
          targetOriginId: 'test',
          viewerProtocolPolicy: 'redirect-to-https'
        }
      }
    });

    // スプレッド演算子を使用したプロパティ指定方法
    const cfnProps = {
      distributionConfig: {
        enabled: true,
        defaultCacheBehavior: {
          targetOriginId: 'test',
          viewerProtocolPolicy: 'redirect-to-https'
        }
      }
    };

    new cdk.aws_cloudfront.CfnDistribution(this, 'SpreadProps', {
      ...cfnProps
    });
  }
}