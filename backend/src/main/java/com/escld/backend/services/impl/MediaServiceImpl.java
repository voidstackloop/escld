package com.escld.backend.services.impl;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import com.escld.backend.dto.PresignedUploadRequest;
import com.escld.backend.dto.PresignedUploadResponse;
import com.escld.backend.exceptions.UnsupportedMediaTypeException;
import com.escld.backend.services.MediaService;

import lombok.extern.slf4j.Slf4j;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.PresignedPutObjectRequest;
import software.amazon.awssdk.services.s3.presigner.model.PutObjectPresignRequest;

@Slf4j
@Service
public class MediaServiceImpl implements MediaService {

    private final S3Presigner s3Presigner;
    private final String bucketName;
    private final String cloudfrontDomain;
    private final Duration presignExpiration;

    public MediaServiceImpl(
            S3Presigner s3Presigner,
            @Value("${app.media.bucket-name}") String bucketName,
            @Value("${app.media.cloudfront-domain}") String cloudfrontDomain,
            @Value("${app.media.presign-expiration-minutes}") long presignExpirationMinutes) {
        this.s3Presigner = s3Presigner;
        this.bucketName = bucketName;
        this.cloudfrontDomain = cloudfrontDomain;
        this.presignExpiration = Duration.ofMinutes(presignExpirationMinutes);
    }

    @Override
    public PresignedUploadResponse createPresignedUpload(UUID userId, PresignedUploadRequest request) {
        if (!request.purpose().supports(request.contentType())) {
            throw new UnsupportedMediaTypeException(request.contentType(), request.purpose());
        }

        String objectKey = buildObjectKey(userId, request);

        PutObjectRequest putObjectRequest = PutObjectRequest.builder()
                .bucket(bucketName)
                .key(objectKey)
                .contentType(request.contentType())
                .build();

        PutObjectPresignRequest presignRequest = PutObjectPresignRequest.builder()
                .signatureDuration(presignExpiration)
                .putObjectRequest(putObjectRequest)
                .build();

        PresignedPutObjectRequest presigned = s3Presigner.presignPutObject(presignRequest);

        log.info("Issued presigned upload for user {} -> {}", userId, objectKey);

        return new PresignedUploadResponse(
                presigned.url().toString(),
                objectKey,
                "https://" + cloudfrontDomain + "/" + objectKey,
                Instant.now().plus(presignExpiration));
    }

    private String buildObjectKey(UUID userId, PresignedUploadRequest request) {
        String extension = extractExtension(request.fileName());
        return "%s/%s/%s%s".formatted(request.purpose().keyPrefix(), userId, UUID.randomUUID(), extension);
    }

    private String extractExtension(String fileName) {
        int dotIndex = fileName.lastIndexOf('.');
        return dotIndex >= 0 ? fileName.substring(dotIndex).toLowerCase() : "";
    }
}
