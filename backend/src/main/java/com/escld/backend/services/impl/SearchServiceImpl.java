package com.escld.backend.services.impl;

import java.util.List;

import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

import com.escld.backend.dto.UserSearchResult;
import com.escld.backend.search.UserSearchDocument;
import com.escld.backend.search.UserSearchRepository;
import com.escld.backend.services.SearchService;

import lombok.RequiredArgsConstructor;

@Service
@RequiredArgsConstructor
public class SearchServiceImpl implements SearchService {

    private static final int MAX_RESULTS = 20;

    private final UserSearchRepository searchRepository;

    // No viewer-specific filtering exists here (confirmed: the same blanket
    // !isPrivateAccount() filter applies regardless of who's asking, no
    // viewer id anywhere in this call chain) — safe to cache by query alone,
    // shared across every user. The SpEL key has to null-guard itself:
    // @Cacheable evaluates the key expression before the method body's own
    // null-check ever runs, so a bare "#query.toLowerCase()" would NPE on a
    // null query instead of reaching the method's existing early return.
    @Override
    @Cacheable(cacheNames = "userSearchResults", key = "#query == null ? '' : #query.trim().toLowerCase()")
    public List<UserSearchResult> searchUsers(String query) {
        if (query == null || query.isBlank()) {
            return List.of();
        }

        return searchRepository.findByUsernameContainingOrDisplayNameContaining(query, query)
                .stream()
                .filter(doc -> !doc.isPrivateAccount())
                .limit(MAX_RESULTS)
                .map(this::toResult)
                .toList();
    }

    private UserSearchResult toResult(UserSearchDocument doc) {
        return new UserSearchResult(
                doc.getId(),
                doc.getUsername(),
                doc.getDisplayName(),
                doc.getAvatarUrl(),
                doc.isVerified(),
                doc.getFollowersCount());
    }
}
