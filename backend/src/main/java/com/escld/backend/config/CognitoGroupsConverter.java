package com.escld.backend.config;

import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import org.springframework.core.convert.converter.Converter;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Maps Cognito's "cognito:groups" claim (group names like "admin",
 * "moderator" - see frontend/amplify/auth/resource.ts) into Spring Security
 * authorities ("ROLE_ADMIN", "ROLE_MODERATOR"), so
 * {@code @PreAuthorize("hasRole('ADMIN')")} works directly against Cognito
 * User Pool Groups - no separate roles table. Every authenticated request
 * also gets ROLE_USER regardless of group membership.
 */
class CognitoGroupsConverter implements Converter<Jwt, java.util.Collection<GrantedAuthority>> {

    @Override
    public java.util.Collection<GrantedAuthority> convert(Jwt jwt) {
        List<String> groups = jwt.getClaimAsStringList("cognito:groups");

        Stream<GrantedAuthority> groupAuthorities = groups == null
                ? Stream.empty()
                : groups.stream()
                        .map(group -> new SimpleGrantedAuthority("ROLE_" + group.toUpperCase(Locale.ROOT)));

        return Stream.concat(Stream.of(new SimpleGrantedAuthority("ROLE_USER")), groupAuthorities)
                .collect(Collectors.toUnmodifiableSet());
    }
}
