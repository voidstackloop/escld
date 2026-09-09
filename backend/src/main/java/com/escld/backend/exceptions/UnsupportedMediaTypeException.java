package com.escld.backend.exceptions;

import com.escld.backend.dto.UploadPurpose;

public class UnsupportedMediaTypeException extends RuntimeException {

    public UnsupportedMediaTypeException(String contentType, UploadPurpose purpose) {
        super("Content type '" + contentType + "' is not allowed for " + purpose
                + ". Allowed: " + purpose.allowedContentTypes());
    }
}
