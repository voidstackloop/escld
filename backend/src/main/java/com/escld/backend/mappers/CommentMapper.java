package com.escld.backend.mappers;

import org.springframework.stereotype.Component;

import com.escld.backend.dto.CommentResponse;
import com.escld.backend.entities.Comment;
import com.escld.backend.entities.User;
import com.escld.backend.services.UserService;

import lombok.RequiredArgsConstructor;

@Component
@RequiredArgsConstructor
public class CommentMapper {

    private final UserService userService;

    public CommentResponse toResponse(Comment comment) {
        return toResponse(comment, userService.getById(comment.getUserId()));
    }

    public CommentResponse toResponse(Comment comment, User author) {
        return new CommentResponse(
                comment.getId(),
                comment.getPostId(),
                author.getId(),
                author.getUsername(),
                author.getDisplayName(),
                author.getAvatarUrl(),
                comment.getText(),
                comment.getCreatedAt());
    }
}
