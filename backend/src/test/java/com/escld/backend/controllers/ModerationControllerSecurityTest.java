package com.escld.backend.controllers;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
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

import com.escld.backend.dto.FileReportRequest;
import com.escld.backend.dto.ResolveReportRequest;
import com.escld.backend.entities.User;
import com.escld.backend.moderation.ReportTargetType;
import com.escld.backend.services.ModerationService;
import com.escld.backend.services.UserService;
import com.escld.backend.user.UserStatus;

/**
 * Same rationale and pattern as UserControllerSecurityTest — calls
 * ModerationController's methods directly through a real Spring AOP
 * method-security proxy, rather than through MockMvc/HTTP, to test the
 * hasAnyRole('ADMIN', 'MODERATOR') check that gates 5 of its 6 endpoints.
 * Not previously covered anywhere in this codebase.
 */
class ModerationControllerSecurityTest {

    private ModerationService moderationService;
    private UserService userService;

    private ModerationController securedController;
    private AnnotationConfigApplicationContext context;

    @org.springframework.boot.test.context.TestConfiguration
    @EnableMethodSecurity
    static class MethodSecurityConfig {
    }

    @BeforeEach
    void setUp() {
        moderationService = mock(ModerationService.class);
        userService = mock(UserService.class);

        ModerationController rawController = new ModerationController(moderationService, userService);

        context = new AnnotationConfigApplicationContext();
        context.registerBean(ModerationController.class, () -> rawController);
        context.register(MethodSecurityConfig.class);
        context.refresh();

        securedController = context.getBean(ModerationController.class);
    }

    @AfterEach
    void tearDown() {
        context.close();
        SecurityContextHolder.clearContext();
    }

    @Test
    void filingAReportRequiresOnlyAuthenticationNotAnyRole() {
        // The one unprotected endpoint here — confirm a plain authenticated
        // user (no admin/moderator group) can genuinely still reach it.
        authenticateAs("ROLE_USER");
        User reporter = actingUser();
        when(userService.getOrProvisionByCognitoSub(any())).thenReturn(reporter);
        UUID targetId = UUID.randomUUID();

        securedController.fileReport(jwtFor(reporter),
                new FileReportRequest(ReportTargetType.POST, targetId, "spam"));

        verify(moderationService).fileReport(reporter.getId(), ReportTargetType.POST, targetId, "spam");
    }

    @Test
    void unauthenticatedCallToOpenReportsIsRejected() {
        assertThatThrownBy(() -> securedController.openReports())
                .isInstanceOf(AuthenticationCredentialsNotFoundException.class);

        verifyNoInteractions(moderationService);
    }

    @Test
    void aPlainUserCannotListOpenReports() {
        authenticateAs("ROLE_USER");

        assertThatThrownBy(() -> securedController.openReports())
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(moderationService);
    }

    @Test
    void aModeratorCanListOpenReports() {
        authenticateAs("ROLE_USER", "ROLE_MODERATOR");
        when(moderationService.listOpenReports()).thenReturn(List.of());

        List<?> result = securedController.openReports();

        org.assertj.core.api.Assertions.assertThat(result).isEmpty();
    }

    @Test
    void aPlainUserCannotResolveAReport() {
        authenticateAs("ROLE_USER");
        UUID reportId = UUID.randomUUID();

        assertThatThrownBy(() -> securedController.resolveReport(null, reportId, new ResolveReportRequest("ok")))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(moderationService);
    }

    @Test
    void anAdminCanResolveAReport() {
        authenticateAs("ROLE_USER", "ROLE_ADMIN");
        User actor = actingUser();
        when(userService.getOrProvisionByCognitoSub(any())).thenReturn(actor);
        UUID reportId = UUID.randomUUID();

        securedController.resolveReport(jwtFor(actor), reportId, new ResolveReportRequest("handled"));

        verify(moderationService).resolveReport(reportId, actor.getId(), "handled");
    }

    @Test
    void aPlainUserCannotSuspendAUser() {
        authenticateAs("ROLE_USER");

        assertThatThrownBy(() -> securedController.suspendUser(null, "someuser"))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(moderationService);
    }

    @Test
    void aModeratorCanSuspendAUser() {
        authenticateAs("ROLE_USER", "ROLE_MODERATOR");
        User actor = actingUser();
        when(userService.getOrProvisionByCognitoSub(any())).thenReturn(actor);

        securedController.suspendUser(jwtFor(actor), "someuser");

        verify(moderationService).suspendUser(actor.getId(), "someuser");
    }

    @Test
    void aPlainUserCannotReinstateAUser() {
        authenticateAs("ROLE_USER");

        assertThatThrownBy(() -> securedController.reinstateUser(null, "someuser"))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(moderationService);
    }

    @Test
    void aPlainUserCannotRemoveAPost() {
        authenticateAs("ROLE_USER");
        UUID postId = UUID.randomUUID();

        assertThatThrownBy(() -> securedController.removePost(null, postId))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(moderationService);
    }

    @Test
    void aPlainUserCannotRemoveAComment() {
        authenticateAs("ROLE_USER");
        UUID commentId = UUID.randomUUID();

        assertThatThrownBy(() -> securedController.removeComment(null, commentId))
                .isInstanceOf(AccessDeniedException.class);

        verifyNoInteractions(moderationService);
    }

    private void authenticateAs(String... roles) {
        List<SimpleGrantedAuthority> authorities = List.of(roles).stream().map(SimpleGrantedAuthority::new).toList();
        SecurityContextHolder.getContext()
                .setAuthentication(new TestingAuthenticationToken("test-user", "n/a", authorities));
    }

    private Jwt jwtFor(User user) {
        return Jwt.withTokenValue("test-token")
                .header("alg", "none")
                .subject(user.getCognitoSub().toString())
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
}
