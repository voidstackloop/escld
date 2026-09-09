package com.escld.backend.config;

import java.net.URI;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.sqs.SqsClient;

@Configuration
public class SqsConfig {

    @Bean
    SqsClient sqsClient(
            @Value("${app.dynamodb.region}") String region,
            @Value("${app.sqs.endpoint:}") String endpointOverride) {
        var builder = SqsClient.builder().region(Region.of(region));

        // Local dev points at the elasticmq container; real deployments leave this
        // unset and the SDK talks to the real regional AWS endpoint.
        if (endpointOverride != null && !endpointOverride.isBlank()) {
            builder.endpointOverride(URI.create(endpointOverride));
        }

        return builder.build();
    }
}
