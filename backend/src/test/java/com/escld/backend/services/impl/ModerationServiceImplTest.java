package com.escld.backend.services.impl;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.escld.backend.entities.User;
import com.escld.backend.moderation.ModerationStore;
import com.escld.backend.moderation.ReportTargetType;
import com.escld.backend.services.CommentService;
import com.escld.backend.services.PostService;
import com.escld.backend.services.UserService;

@ExtendWith(MockitoExtension.class)
class ModerationServiceImplTest {

    @Mock
    private ModerationStore moderationStore;
    @Mock
    private UserService userService;
    @Mock
    private PostService postService;
    @Mock
    private CommentService commentService;

    @InjectMocks
    private ModerationServiceImpl moderationService;

    private final UUID moderatorId = UUID.randomUUID();
    private final UUID targetUserId = UUID.randomUUID();
    private final String targetUsername = "troublemaker";

    @Test
    void fileReportVerifiesTheTargetExistsThenDelegatesToTheStore() {
        UUID reporterId = UUID.randomUUID();
        UUID targetId = UUID.randomUUID();

        moderationService.fileReport(reporterId, ReportTargetType.POST, targetId, "spam");

        verify(postService).getById(targetId);
        verify(moderationStore).fileReport(reporterId, ReportTargetType.POST, targetId, "spam");
    }

    @Test
    void suspendingAUserUpdatesStatusAndLogsAnAuditEntry() {
        User target = User.builder().id(targetUserId).username(targetUsername).build();
        when(userService.getByUsername(targetUsername)).thenReturn(target);

        moderationService.suspendUser(moderatorId, targetUsername);

        verify(userService).suspendUser(targetUserId);
        verify(moderationStore).logAction(eq(moderatorId), eq("SUSPEND_USER"), eq("USER"),
                eq(targetUserId.toString()));
    }

    @Test
    void reinstatingAUserActivatesAndLogsAnAuditEntry() {
        User target = User.builder().id(targetUserId).username(targetUsername).build();
        when(userService.getByUsername(targetUsername)).thenReturn(target);

        moderationService.reinstateUser(moderatorId, targetUsername);

        verify(userService).activateUser(targetUserId);
        verify(moderationStore).logAction(eq(moderatorId), eq("REINSTATE_USER"), eq("USER"),
                eq(targetUserId.toString()));
    }

    @Test
    void resolvingAReportDelegatesToTheStore() {
        UUID reportId = UUID.randomUUID();

        moderationService.resolveReport(reportId, moderatorId, "handled");

        verify(moderationStore).resolveReport(reportId, moderatorId, "handled");
        verify(moderationStore, never()).logAction(any(), any(), any(), any());
    }

    @Test
    void removingAPostDeletesItAsModeratorAndLogsAnAuditEntry() {
        UUID postId = UUID.randomUUID();

        moderationService.removePost(moderatorId, postId);

        verify(postService).deletePostAsModerator(postId);
        verify(moderationStore).logAction(moderatorId, "REMOVE_POST", "POST", postId.toString());
    }

    @Test
    void removingACommentDeletesItAsModeratorAndLogsAnAuditEntry() {
        UUID commentId = UUID.randomUUID();

        moderationService.removeComment(moderatorId, commentId);

        verify(commentService).deleteCommentAsModerator(commentId, moderatorId);
        verify(moderationStore).logAction(moderatorId, "REMOVE_COMMENT", "COMMENT", commentId.toString());
    }
}
