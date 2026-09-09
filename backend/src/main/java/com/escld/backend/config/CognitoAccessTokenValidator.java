package com.escld.backend.config;

import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Cognito access tokens (unlike ID tokens) carry no "aud" claim, so the usual
 * audience check doesn't apply. Instead Cognito puts the app client id in
 * "client_id" and marks the token's purpose via "token_use". This rejects
 * ID tokens and tokens issued to a different app client.
 */
class CognitoAccessTokenValidator implements OAuth2TokenValidator<Jwt> {

    private static final OAuth2Error WRONG_TOKEN_USE =
            new OAuth2Error("invalid_token", "Expected an access token (token_use=access)", null);

    private static final OAuth2Error WRONG_CLIENT_ID =
            new OAuth2Error("invalid_token", "Token was not issued to the expected app client", null);

    private final String expectedClientId;

    CognitoAccessTokenValidator(String expectedClientId) {
        this.expectedClientId = expectedClientId;
    }

    @Override
    public OAuth2TokenValidatorResult validate(Jwt token) {
        if (!"access".equals(token.getClaimAsString("token_use"))) {
            return OAuth2TokenValidatorResult.failure(WRONG_TOKEN_USE);
        }
        if (!expectedClientId.equals(token.getClaimAsString("client_id"))) {
            return OAuth2TokenValidatorResult.failure(WRONG_CLIENT_ID);
        }
        return OAuth2TokenValidatorResult.success();
    }
}
