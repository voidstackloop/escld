package com.escld.backend.live;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.escld.backend.repo.UserRepository;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

@Slf4j
@Service
@RequiredArgsConstructor
public class StreamKeyServiceImpl implements StreamKeyService {

    private final UserRepository userRepository;

    /**
     * Real bug found via local end-to-end testing: userRepository.updateStreamKey
     * is a @Modifying bulk-update query, which Hibernate refuses to execute
     * outside an active transaction (TransactionRequiredException) — missing
     * @Transactional here meant this endpoint 500'd on every single call, a
     * gap invisible to the existing mocked-repository unit test since
     * Mockito has no concept of transaction boundaries at all.
     */
    @Override
    @Transactional
    public UUID regenerate(UUID userId) {
        UUID streamKey = UUID.randomUUID();
        userRepository.updateStreamKey(userId, streamKey);
        log.info("Stream key regenerated for user {}", userId);
        return streamKey;
    }
}
