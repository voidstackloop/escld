import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LikesStack } from '../lib/likes-stack';

test('creates the likes table with pk/sk keys', () => {
  const app = new cdk.App();
  const stack = new LikesStack(app, 'TestLikesStack1');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'likes',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
});

// The base table's sk (LIKE#<userId> / LIKED#<postId>) isn't date-ordered —
// feed ranking's "this viewer's most recently liked posts" query needs this
// GSI to get a genuinely recency-ordered result instead of an arbitrary
// frozen subset (see FeedServiceImpl / LikeStore#listRecentLikedPostIds).
test('exposes a byUserRecency GSI keyed on pk/createdAt for recency-ordered queries', () => {
  const app = new cdk.App();
  const stack = new LikesStack(app, 'TestLikesStack2');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: 'byUserRecency',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      }),
    ]),
  });
});
