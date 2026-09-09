package com.escld.backend.live;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.repo.UserRepository;

@ExtendWith(MockitoExtension.class)
class StreamKeyServiceImplTest {

    @Mock
    private UserRepository userRepository;

    @InjectMocks
    private StreamKeyServiceImpl service;

    @Test
    void regeneratesAFreshRandomKeyAndPersistsItAgainstTheUser() {
        UUID userId = UUID.randomUUID();

        UUID first = service.regenerate(userId);
        UUID second = service.regenerate(userId);

        assertThat(first).isNotEqualTo(second);
        verify(userRepository).updateStreamKey(eq(userId), eq(first));
        verify(userRepository).updateStreamKey(eq(userId), eq(second));
    }
}
