package com.escld.backend.services.impl;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.oauth2.jwt.Jwt;

import com.escld.backend.entities.User;
import com.escld.backend.exceptions.UsernameAlreadyTakenException;
import com.escld.backend.repo.UserRepository;
import com.escld.backend.search.UserSearchIndexer;
import com.escld.backend.user.CognitoUserAttributesClient;

/**
 * Covers getOrProvisionByCognitoSub specifically — the fix for two real gaps
 * found while setting up local end-to-end testing: (1) nothing anywhere in
 * this app (no post-confirmation Cognito Lambda, no explicit "create
 * profile" call from the frontend) ever created a users row for a freshly
 * signed-up Cognito identity, so a real new user's very first authenticated
 * request would have 404'd; (2) the first fix attempt read
 * email/preferred_username/picture straight off the JWT, which only works
 * for an ID token — this app's resource server deliberately validates
 * access tokens only (CognitoAccessTokenValidator), which carry none of
 * those claims, so attributes are fetched via CognitoUserAttributesClient's
 * GetUser call instead. See UserService's own javadoc for the full context.
 */
@ExtendWith(MockitoExtension.class)
class UserServiceImplTest {

    @Mock
    private UserRepository userRepository;
    @Mock
    private UserSearchIndexer searchIndexer;
    @Mock
    private CognitoUserAttributesClient cognitoUserAttributesClient;

    @InjectMocks
    private UserServiceImpl userService;

    private final UUID cognitoSub = UUID.randomUUID();

    @Test
    void returnsTheExistingUserWithoutProvisioningWhenOneAlreadyExistsForTheCognitoIdentity() {
        User existing = User.builder().id(UUID.randomUUID()).cognitoSub(cognitoSub).username("someone")
                .email("someone@example.com").displayName("someone").build();
        when(userRepository.findByCognitoSub(cognitoSub)).thenReturn(Optional.of(existing));

        User result = userService.getOrProvisionByCognitoSub(jwtFor(cognitoSub));

        assertThat(result).isSameAs(existing);
        verify(userRepository, never()).save(any());
        verify(searchIndexer, never()).index(any());
        verify(cognitoUserAttributesClient, never()).fetchAttributes(any());
    }

    @Test
    void provisionsANewProfileFromTheCallersRealCognitoAttributesWhenNoneExistsYetForTheIdentity() {
        when(userRepository.findByCognitoSub(cognitoSub)).thenReturn(Optional.empty());
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> invocation.getArgument(0));
        when(cognitoUserAttributesClient.fetchAttributes("test-token")).thenReturn(attributes(
                "new.user@example.com", "newuser", "https://example.com/avatar.svg"));

        User result = userService.getOrProvisionByCognitoSub(jwtFor(cognitoSub));

        assertThat(result.getCognitoSub()).isEqualTo(cognitoSub);
        assertThat(result.getEmail()).isEqualTo("new.user@example.com");
        assertThat(result.getUsername()).isEqualTo("newuser");
        assertThat(result.getDisplayName()).isEqualTo("newuser");
        assertThat(result.getAvatarUrl()).isEqualTo("https://example.com/avatar.svg");
        assertThat(result.getStatus().name()).isEqualTo("ACTIVE");
        verify(searchIndexer).index(result);
    }

    @Test
    void surfacesAUsernameCollisionDuringProvisioningAsUsernameAlreadyTakenRatherThanARawDbError() {
        when(userRepository.findByCognitoSub(cognitoSub)).thenReturn(Optional.empty());
        when(userRepository.save(any(User.class))).thenThrow(new DataIntegrityViolationException("duplicate key"));
        when(cognitoUserAttributesClient.fetchAttributes("test-token"))
                .thenReturn(attributes("taken@example.com", "takenname", null));

        assertThatThrownBy(() -> userService.getOrProvisionByCognitoSub(jwtFor(cognitoSub)))
                .isInstanceOf(UsernameAlreadyTakenException.class);
    }

    private Map<String, String> attributes(String email, String preferredUsername, String picture) {
        Map<String, String> attrs = new HashMap<>();
        attrs.put("email", email);
        attrs.put("preferred_username", preferredUsername);
        if (picture != null) {
            attrs.put("picture", picture);
        }
        return attrs;
    }

    private Jwt jwtFor(UUID sub) {
        return Jwt.withTokenValue("test-token")
                .header("alg", "none")
                .subject(sub.toString())
                .claim("token_use", "access")
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600))
                .build();
    }
}
