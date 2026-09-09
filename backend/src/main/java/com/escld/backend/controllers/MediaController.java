package com.escld.backend.controllers;

import java.util.UUID;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.PresignedUploadRequest;
import com.escld.backend.dto.PresignedUploadResponse;
import com.escld.backend.services.MediaService;
import com.escld.backend.services.UserService;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

@RestController
@RequestMapping("/api/v1/media")
@RequiredArgsConstructor
public class MediaController {

    private final MediaService mediaService;
    private final UserService userService;

    @PostMapping("/presigned-upload")
    public PresignedUploadResponse createPresignedUpload(@AuthenticationPrincipal Jwt jwt,
            @Valid @RequestBody PresignedUploadRequest request) {
        UUID userId = userService.getOrProvisionByCognitoSub(jwt).getId();
        return mediaService.createPresignedUpload(userId, request);
    }
}
