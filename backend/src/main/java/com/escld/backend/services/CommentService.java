package com.escld.backend.services;

import java.util.List;
import java.util.UUID;

import com.escld.backend.entities.Comment;

public interface CommentService {

    Comment getById(UUID commentId);

    Comment createComment(UUID postId, UUID authorId, String text);

    List<Comment> getByPostId(UUID postId);

    void deleteComment(UUID commentId, UUID requesterId);

    /** Moderator override — removes any comment regardless of ownership. */
    void deleteCommentAsModerator(UUID commentId, UUID moderatorId);
}
