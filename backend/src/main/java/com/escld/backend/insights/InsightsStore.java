package com.escld.backend.insights;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;

/**
 * Read-only access to the materialized per-post and per-creator daily
 * insights bq-sink's insights-export.ts writes — see
 * infra/lib/insights-stack.ts. This backend never writes here: bq-sink's
 * hourly export (pulling from BigQuery's already-maintained post_daily/
 * creator_daily tables) is the sole writer.
 *
 * pk = {@code POST#<postId>} or {@code CREATOR#<userId>}; sk =
 * {@code DATE#<yyyy-mm-dd>}. Both entity families share the exact same sk
 * shape, so one range query answers "this post's last 28 days" and "this
 * creator's last 28 days" identically — the only difference is which pk
 * prefix the caller builds.
 */
@Component
public class InsightsStore {

    public static final String POST_PREFIX = "POST#";
    public static final String CREATOR_PREFIX = "CREATOR#";

    private final DynamoDbClient dynamoDbClient;
    private final String tableName;

    public InsightsStore(DynamoDbClient dynamoDbClient, @Value("${app.dynamodb.insights-table-name}") String tableName) {
        this.dynamoDbClient = dynamoDbClient;
        this.tableName = tableName;
    }

    public List<Map<String, AttributeValue>> queryPostRange(UUID postId, LocalDate from, LocalDate to) {
        return queryRange(POST_PREFIX + postId, from, to);
    }

    public List<Map<String, AttributeValue>> queryCreatorRange(UUID userId, LocalDate from, LocalDate to) {
        return queryRange(CREATOR_PREFIX + userId, from, to);
    }

    private List<Map<String, AttributeValue>> queryRange(String pk, LocalDate from, LocalDate to) {
        var response = dynamoDbClient.query(QueryRequest.builder()
                .tableName(tableName)
                .keyConditionExpression("pk = :pk AND sk BETWEEN :skFrom AND :skTo")
                .expressionAttributeValues(Map.of(
                        ":pk", AttributeValue.fromS(pk),
                        ":skFrom", AttributeValue.fromS("DATE#" + from),
                        // `to` itself is exclusive per the API contract (see
                        // PostInsightsService/AccountInsightsService), so the
                        // last real day included is `to.minusDays(1)`.
                        ":skTo", AttributeValue.fromS("DATE#" + to.minusDays(1))))
                .build());
        return response.items();
    }

    public static String string(Map<String, AttributeValue> item, String key) {
        AttributeValue value = item.get(key);
        return value == null || Boolean.TRUE.equals(value.nul()) ? null : value.s();
    }

    public static Long longValue(Map<String, AttributeValue> item, String key) {
        AttributeValue value = item.get(key);
        return value == null || value.n() == null ? null : Long.valueOf(value.n());
    }

    public static Boolean booleanValue(Map<String, AttributeValue> item, String key) {
        AttributeValue value = item.get(key);
        return value == null ? null : value.bool();
    }

    public static LocalDate day(Map<String, AttributeValue> item) {
        // sk is "DATE#yyyy-MM-dd" — strip the fixed prefix rather than
        // parsing generically, matching FollowGraphStore's own
        // sk-prefix-stripping convention for its FOLLOWING#/FOLLOWER# items.
        return LocalDate.parse(item.get("sk").s().substring("DATE#".length()));
    }
}
