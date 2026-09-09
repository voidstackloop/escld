package com.escld.backend.config;

import java.net.URI;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;

@Configuration
public class DynamoDbConfig {

    @Bean
    DynamoDbClient dynamoDbClient(
            @Value("${app.dynamodb.region}") String region,
            @Value("${app.dynamodb.endpoint:}") String endpointOverride) {
        var builder = DynamoDbClient.builder().region(Region.of(region));

        // Local dev points at the dynamodb-local container; real deployments leave
        // this unset and the SDK talks to the real regional AWS endpoint.
        if (endpointOverride != null && !endpointOverride.isBlank()) {
            builder.endpointOverride(URI.create(endpointOverride));
        }

        return builder.build();
    }
}
