package com.escld.backend.controllers;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.AuthenticationCredentialsNotFoundException;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

import com.escld.backend.entities.User;
import com.escld.backend.insights.CreatorStudioService;
import com.escld.backend.mappers.UserMapper;
import com.escld.backend.moderation.ModerationStore;
import com.escld.backend.services.AccountDeletionService;
import com.escld.backend.services.UserService;
import com.escld.backend.user.UserStatus;

/**
 * The first test in this codebase of a @PreAuthorize check actually being
 * enforced — UserController's activate/suspend/deactivate (and
 * ModerationController's identical hasAnyRole('ADMIN', 'MODERATOR')
 * endpoints) had this annotation since before this session, with zero
 * coverage that it does anything.
 *
 * Deliberately calls the controller's methods directly through a real
 * Spring AOP method-security proxy (built from a minimal
 * AnnotationConfigApplicationContext with just @EnableMethodSecurity — not
 * the real SecurityConfig, whose jwtDecoder() bean makes a live network call
 * to the real Cognito issuer at bean-creation time) rather than going
 * through MockMvc/HTTP. @PreAuthorize is enforced by AOP method
 * interception, not the servlet filter chain, so this tests the actual
 * mechanism directly without needing to stand up DispatcherServlet, request
 * routing, or JSON serialization — none of which is what's actually in
 * question here.
 */
class UserControllerSecurityTest {

    private UserService userService;
    private UserMapper userMapper;
    private ModerationStore moderationStore;
    private AccountDeletionService accountDeletionService;
    private CreatorStudioService creatorStudioService;

    private UserController securedController;
    private AnnotationConfigApplicationContext context;

    private final UUID targetUserId = UUID.randomUUID();

    @org.springframework.boot.test.context.TestConfiguration
    @EnableMethodSecurity
    static class MethodSecurityConfig {
    }

    @BeforeEach
    void setUp() {
        userService = mock(UserService.class);
        userMapper = mock(UserMapper.class);
        moderationStore = mock(ModerationStore.class);
        accountDeletionService = mock(AccountDeletionService.class);
        creatorStudioService = mock(CreatorStudioService.class);

        UserController rawController =
                new UserController(userService, userMapper, moderationStore, accountDeletionService, creatorStudioService);

        context = new AnnotationConfigApplicationContext();
        context.registerBean(UserController.class, () -> rawController);
        context.register(MethodSecurityConfig.class);
        context.refresh();

        securedController = context.getBean(UserController.class);
    }

    @AfterEach
    void tearDown() {
        context.close();
        SecurityContextHolder.clearContext();
    }

    @Test
    void unauthenticatedCallToActivateIsRejected() {
        // No Authentication at all in the SecurityContext.
        assertThatThrownBy(() -> securedController.activate(null, targetUserId))
                .isInstanceOf(AuthenticationCredentialsNotFoundException.class);

        verifyNoInteractions(userService);
    }

    @Test
    void aPlainUserCannotActivateAnotherUser() {
        authenticateAs("ROLE_USER");

        assertThatThrownBy(() -> securedController.activate(null, targetUserId))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(userService);
    }

    @Test
    void aModeratorCanActivateAUser() {
        authenticateAs("ROLE_USER", "ROLE_MODERATOR");
        User actor = actingUser();
        Jwt jwt = jwtFor(actor);
        when(userService.getOrProvisionByCognitoSub(any())).thenReturn(actor);
        when(userService.activateUser(targetUserId)).thenReturn(targetUser());

        securedController.activate(jwt, targetUserId);

        org.mockito.Mockito.verify(userService).activateUser(targetUserId);
        org.mockito.Mockito.verify(moderationStore)
                .logAction(actor.getId(), "ACTIVATE_USER", "USER", targetUserId.toString());
    }

    @Test
    void anAdminCanSuspendAUser() {
        authenticateAs("ROLE_USER", "ROLE_ADMIN");
        User actor = actingUser();
        Jwt jwt = jwtFor(actor);
        when(userService.getOrProvisionByCognitoSub(any())).thenReturn(actor);
        when(userService.suspendUser(targetUserId)).thenReturn(targetUser());

        securedController.suspend(jwt, targetUserId);

        org.mockito.Mockito.verify(userService).suspendUser(targetUserId);
    }

    @Test
    void aPlainUserCannotDeactivateAnotherUser() {
        authenticateAs("ROLE_USER");

        assertThatThrownBy(() -> securedController.deactivate(null, targetUserId))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(userService);
    }

    @Test
    void selfServiceEndpointsAreNotGatedByRole() {
        // GET /me carries no @PreAuthorize at all (see UserController) — confirm
        // that's genuinely still the case, not an oversight this test should have
        // caught: a plain authenticated user (no admin/moderator group) can still
        // reach it without an AccessDeniedException.
        authenticateAs("ROLE_USER");
        User self = actingUser();
        when(userService.getOrProvisionByCognitoSub(any())).thenReturn(self);

        securedController.getCurrentUser(jwtFor(self));

        org.mockito.Mockito.verify(userService).getOrProvisionByCognitoSub(any());
    }

    private void authenticateAs(String... roles) {
        List<SimpleGrantedAuthority> authorities = List.of(roles).stream().map(SimpleGrantedAuthority::new).toList();
        SecurityContextHolder.getContext()
                .setAuthentication(new TestingAuthenticationToken("test-user", "n/a", authorities));
    }

    private Jwt jwtFor(User user) {
        return Jwt.withTokenValue("test-token")
                .header("alg", "none")
                .subject(user.getCognitoSub() != null ? user.getCognitoSub().toString() : UUID.randomUUID().toString())
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600))
                .build();
    }

    private User actingUser() {
        return User.builder()
                .id(UUID.randomUUID())
                .cognitoSub(UUID.randomUUID())
                .username("moderator")
                .status(UserStatus.ACTIVE)
                .build();
    }

    private User targetUser() {
        return User.builder()
                .id(targetUserId)
                .cognitoSub(UUID.randomUUID())
                .username("target")
                .status(UserStatus.ACTIVE)
                .build();
    }
}
