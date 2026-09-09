package com.escld.backend.search;

import org.springframework.stereotype.Component;

import com.escld.backend.entities.User;

/**
 * Keeps the Elasticsearch search index in sync with Postgres. Best-effort:
 * search is a convenience feature, not the source of truth, so callers don't
 * need to roll back a profile update if indexing hiccups.
 */
@Component
public class UserSearchIndexer {

    private final UserSearchRepository searchRepository;

    public UserSearchIndexer(UserSearchRepository searchRepository) {
        this.searchRepository = searchRepository;
    }

    public void index(User user) {
        searchRepository.save(toDocument(user));
    }

    public void delete(User user) {
        searchRepository.deleteById(user.getId().toString());
    }

    private UserSearchDocument toDocument(User user) {
        return UserSearchDocument.builder()
                .id(user.getId().toString())
                .username(user.getUsername())
                .displayName(user.getDisplayName())
                .bio(user.getBio())
                .avatarUrl(user.getAvatarUrl())
                .verified(user.isVerified())
                .privateAccount(user.isPrivateAccount())
                .followersCount(user.getFollowersCount())
                .build();
    }
}
