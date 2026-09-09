package com.escld.backend.services;

import java.util.UUID;

import com.escld.backend.dto.PresignedUploadRequest;
import com.escld.backend.dto.PresignedUploadResponse;

public interface MediaService {

    /**
     * Issues a short-lived presigned S3 PUT URL the client uploads directly to,
     * plus the public (CloudFront) URL the object will be reachable at afterward.
     */
    PresignedUploadResponse createPresignedUpload(UUID userId, PresignedUploadRequest request);
}
