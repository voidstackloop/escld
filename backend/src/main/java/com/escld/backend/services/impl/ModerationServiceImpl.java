package com.escld.backend.services.impl;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;

import com.escld.backend.dto.ReportSummary;
import com.escld.backend.entities.User;
import com.escld.backend.moderation.ModerationStore;
import com.escld.backend.moderation.ReportTargetType;
import com.escld.backend.services.CommentService;
import com.escld.backend.services.ModerationService;
import com.escld.backend.services.PostService;
import com.escld.backend.services.UserService;

import lombok.RequiredArgsConstructor;

@Service
@RequiredArgsConstructor
public class ModerationServiceImpl implements ModerationService {

    private final ModerationStore moderationStore;
    private final UserService userService;
    private final PostService postService;
    private final CommentService commentService;

    @Override
    public ReportSummary fileReport(UUID reporterId, ReportTargetType targetType, UUID targetId, String reason) {
        // Fails with the same NotFoundException each service already throws
        // elsewhere (see GlobalExceptionHandler) if the target doesn't exist -
        // keeps the moderation queue free of reports nobody can act on.
        switch (targetType) {
            case POST -> postService.getById(targetId);
            case COMMENT -> commentService.getById(targetId);
            case USER -> userService.getById(targetId);
        }

        return moderationStore.fileReport(reporterId, targetType, targetId, reason);
    }

    @Override
    public List<ReportSummary> listOpenReports() {
        return moderationStore.listOpenReports();
    }

    @Override
    public void resolveReport(UUID reportId, UUID moderatorId, String note) {
        moderationStore.resolveReport(reportId, moderatorId, note);
    }

    @Override
    public void suspendUser(UUID moderatorId, String username) {
        User target = userService.getByUsername(username);
        userService.suspendUser(target.getId());
        moderationStore.logAction(moderatorId, "SUSPEND_USER", "USER", target.getId().toString());
    }

    @Override
    public void reinstateUser(UUID moderatorId, String username) {
        User target = userService.getByUsername(username);
        userService.activateUser(target.getId());
        moderationStore.logAction(moderatorId, "REINSTATE_USER", "USER", target.getId().toString());
    }

    @Override
    public void removePost(UUID moderatorId, UUID postId) {
        postService.deletePostAsModerator(postId);
        moderationStore.logAction(moderatorId, "REMOVE_POST", "POST", postId.toString());
    }

    @Override
    public void removeComment(UUID moderatorId, UUID commentId) {
        commentService.deleteCommentAsModerator(commentId, moderatorId);
        moderationStore.logAction(moderatorId, "REMOVE_COMMENT", "COMMENT", commentId.toString());
    }
}
