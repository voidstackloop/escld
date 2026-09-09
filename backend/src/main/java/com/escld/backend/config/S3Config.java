package com.escld.backend.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;

@Configuration
public class S3Config {

    @Bean
    S3Presigner s3Presigner(@Value("${app.media.region}") String region) {
        return S3Presigner.builder()
                .region(Region.of(region))
                .build();
    }

    // The presigner above only ever issues presigned PUT URLs for uploads —
    // nothing in this service could delete an object until now. Used by
    // AccountDeletionService to actually remove a deleted user's media
    // rather than leaving it orphaned in S3 forever.
    @Bean
    S3Client s3Client(@Value("${app.media.region}") String region) {
        return S3Client.builder()
                .region(Region.of(region))
                .build();
    }
}
