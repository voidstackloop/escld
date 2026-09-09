package com.escld.backend.user;

import java.util.Map;
import java.util.stream.Collectors;

import org.springframework.stereotype.Component;

import lombok.RequiredArgsConstructor;
import software.amazon.awssdk.services.cognitoidentityprovider.CognitoIdentityProviderClient;
import software.amazon.awssdk.services.cognitoidentityprovider.model.AttributeType;
import software.amazon.awssdk.services.cognitoidentityprovider.model.GetUserRequest;
import software.amazon.awssdk.services.cognitoidentityprovider.model.GetUserResponse;

/**
 * Fetches the caller's own Cognito attributes (email, preferred_username,
 * picture) directly from their bearer access token, via Cognito's GetUser
 * API — the one Cognito Identity Provider operation that authenticates
 * purely via the passed token itself, no IAM signing needed. Exists because
 * this app's resource server deliberately validates access tokens, never ID
 * tokens (see CognitoAccessTokenValidator's own doc), and Cognito access
 * tokens carry none of these custom/profile attributes — only ID tokens do.
 * UserServiceImpl#provision is the one caller: it needs these fields to
 * create a new user's Postgres profile row on first sight of their identity.
 */
@Component
@RequiredArgsConstructor
public class CognitoUserAttributesClient {

    private final CognitoIdentityProviderClient cognitoClient;

    /** Keyed by Cognito attribute name ("email", "preferred_username",
     * "picture", etc.) — callers pick out the specific attributes they
     * need; a missing key means Cognito simply has no value for it. */
    public Map<String, String> fetchAttributes(String accessToken) {
        GetUserResponse response = cognitoClient.getUser(GetUserRequest.builder()
                .accessToken(accessToken)
                .build());

        return response.userAttributes().stream()
                .collect(Collectors.toMap(AttributeType::name, AttributeType::value));
    }
}
