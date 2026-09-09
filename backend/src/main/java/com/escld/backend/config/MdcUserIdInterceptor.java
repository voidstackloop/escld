package com.escld.backend.config;

import org.jspecify.annotations.NonNull;
import org.slf4j.MDC;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Adds the authenticated Cognito subject to MDC so every log line for this
 * request carries userId alongside correlationId — a HandlerInterceptor
 * rather than a Filter because it needs to run after Spring Security has
 * already resolved the JWT into an Authentication, which filters ahead of
 * the security chain (like CorrelationIdFilter) cannot see.
 */
@Component
public class MdcUserIdInterceptor implements HandlerInterceptor {

    private static final String MDC_KEY = "userId";

    @Override
    public boolean preHandle(@NonNull HttpServletRequest request, @NonNull HttpServletResponse response,
            @NonNull Object handler) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof Jwt jwt) {
            MDC.put(MDC_KEY, jwt.getSubject());
        }
        return true;
    }

    @Override
    public void afterCompletion(@NonNull HttpServletRequest request, @NonNull HttpServletResponse response,
            @NonNull Object handler, Exception ex) {
        MDC.remove(MDC_KEY);
    }
}
