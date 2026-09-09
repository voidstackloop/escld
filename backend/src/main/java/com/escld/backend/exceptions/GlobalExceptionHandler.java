package com.escld.backend.exceptions;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;

import lombok.extern.slf4j.Slf4j;
import com.escld.backend.feed.FeedSnapshotExpiredException;
import com.escld.backend.feed.InvalidFeedCursorException;

/**
 * Every domain exception handler routes through the single {@code respond}
 * overload that takes the exception itself, so each one gets logged exactly
 * once, in exactly one place, rather than needing a duplicated log.warn line
 * per handler. Domain exceptions log at WARN (not ERROR): they're expected,
 * client-facing outcomes (not-found, ownership, private-account, etc.), but
 * still worth a real log line — a spike in one of these (e.g. repeated
 * PrivateAccountException for the same account, or NotPostOwnerException
 * probing) is a legitimate signal, and before this change none of them left
 * any trace at all. MDC already carries the request's correlationId (see
 * CorrelationIdFilter), so every line here is already traceable back to the
 * exact request/response pair logged by RequestLoggingFilter without needing
 * to thread anything extra through by hand.
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(AnalyticsRateLimitExceededException.class)
    public ResponseEntity<ApiError> handleAnalyticsRateLimit(AnalyticsRateLimitExceededException ex,
            WebRequest request) {
        log.warn("AnalyticsRateLimitExceededException -> 429 on {}: {}", path(request), ex.getMessage());
        ApiError body = ApiError.of(HttpStatus.TOO_MANY_REQUESTS.value(),
                HttpStatus.TOO_MANY_REQUESTS.getReasonPhrase(), ex.getMessage(), path(request));
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .header(HttpHeaders.RETRY_AFTER, String.valueOf(ex.retryAfterSeconds()))
                .body(body);
    }

    @ExceptionHandler(InvalidFeedCursorException.class)
    public ResponseEntity<ApiError> handleInvalidFeedCursor(InvalidFeedCursorException ex, WebRequest request) {
        return respond(HttpStatus.BAD_REQUEST, ex, request);
    }

    @ExceptionHandler(FeedSnapshotExpiredException.class)
    public ResponseEntity<ApiError> handleFeedSnapshotExpired(FeedSnapshotExpiredException ex, WebRequest request) {
        return respond(HttpStatus.GONE, ex, request);
    }

    @ExceptionHandler(UserNotFoundException.class)
    public ResponseEntity<ApiError> handleUserNotFound(UserNotFoundException ex, WebRequest request) {
        return respond(HttpStatus.NOT_FOUND, ex, request);
    }

    @ExceptionHandler(UsernameAlreadyTakenException.class)
    public ResponseEntity<ApiError> handleUsernameTaken(UsernameAlreadyTakenException ex, WebRequest request) {
        return respond(HttpStatus.CONFLICT, ex, request);
    }

    @ExceptionHandler(UnsupportedMediaTypeException.class)
    public ResponseEntity<ApiError> handleUnsupportedMediaType(UnsupportedMediaTypeException ex,
            WebRequest request) {
        return respond(HttpStatus.UNSUPPORTED_MEDIA_TYPE, ex, request);
    }

    @ExceptionHandler(SelfFollowException.class)
    public ResponseEntity<ApiError> handleSelfFollow(SelfFollowException ex, WebRequest request) {
        return respond(HttpStatus.BAD_REQUEST, ex, request);
    }

    @ExceptionHandler(PrivateAccountException.class)
    public ResponseEntity<ApiError> handlePrivateAccount(PrivateAccountException ex, WebRequest request) {
        return respond(HttpStatus.FORBIDDEN, ex, request);
    }

    @ExceptionHandler(FollowRequestNotFoundException.class)
    public ResponseEntity<ApiError> handleFollowRequestNotFound(FollowRequestNotFoundException ex,
            WebRequest request) {
        return respond(HttpStatus.NOT_FOUND, ex, request);
    }

    @ExceptionHandler(InvalidPostException.class)
    public ResponseEntity<ApiError> handleInvalidPost(InvalidPostException ex, WebRequest request) {
        return respond(HttpStatus.BAD_REQUEST, ex, request);
    }

    @ExceptionHandler(PostNotFoundException.class)
    public ResponseEntity<ApiError> handlePostNotFound(PostNotFoundException ex, WebRequest request) {
        return respond(HttpStatus.NOT_FOUND, ex, request);
    }

    @ExceptionHandler(NotPostOwnerException.class)
    public ResponseEntity<ApiError> handleNotPostOwner(NotPostOwnerException ex, WebRequest request) {
        return respond(HttpStatus.FORBIDDEN, ex, request);
    }

    @ExceptionHandler(CommentNotFoundException.class)
    public ResponseEntity<ApiError> handleCommentNotFound(CommentNotFoundException ex, WebRequest request) {
        return respond(HttpStatus.NOT_FOUND, ex, request);
    }

    @ExceptionHandler(NotCommentOwnerException.class)
    public ResponseEntity<ApiError> handleNotCommentOwner(NotCommentOwnerException ex, WebRequest request) {
        return respond(HttpStatus.FORBIDDEN, ex, request);
    }

    @ExceptionHandler(ReportNotFoundException.class)
    public ResponseEntity<ApiError> handleReportNotFound(ReportNotFoundException ex, WebRequest request) {
        return respond(HttpStatus.NOT_FOUND, ex, request);
    }

    // Without this, InsightsUnavailableException fell through to the
    // Exception.class catch-all below and reported 500 instead of its own
    // @ResponseStatus(SERVICE_UNAVAILABLE) — @ResponseStatus alone is not
    // honored once a RestControllerAdvice with a catch-all handler is
    // active, since Spring's normal @ResponseStatus resolution only
    // applies when no @ExceptionHandler claims the exception first. Only
    // live-testing GET /users/me/insights caught this: every prior test
    // called the service layer directly, bypassing this handler entirely.
    @ExceptionHandler(InsightsUnavailableException.class)
    public ResponseEntity<ApiError> handleInsightsUnavailable(InsightsUnavailableException ex, WebRequest request) {
        return respond(HttpStatus.SERVICE_UNAVAILABLE, ex, request);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> handleValidation(MethodArgumentNotValidException ex, WebRequest request) {
        Map<String, String> fieldErrors = new LinkedHashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(
                fieldError -> fieldErrors.put(fieldError.getField(), fieldError.getDefaultMessage()));

        log.warn("Validation failed on {}: {}", path(request), fieldErrors);

        ApiError body = ApiError.ofValidation(
                HttpStatus.BAD_REQUEST.value(),
                HttpStatus.BAD_REQUEST.getReasonPhrase(),
                "Validation failed",
                path(request),
                fieldErrors);

        return ResponseEntity.badRequest().body(body);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiError> handleIllegalArgument(IllegalArgumentException ex, WebRequest request) {
        return respond(HttpStatus.BAD_REQUEST, ex, request);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiError> handleUnexpected(Exception ex, WebRequest request) {
        log.error("Unhandled exception on {}", path(request), ex);
        return respond(HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred", request);
    }

    private ResponseEntity<ApiError> respond(HttpStatus status, Exception ex, WebRequest request) {
        log.warn("{} -> {} on {}: {}", ex.getClass().getSimpleName(), status.value(), path(request), ex.getMessage());
        return respond(status, ex.getMessage(), request);
    }

    private ResponseEntity<ApiError> respond(HttpStatus status, String message, WebRequest request) {
        ApiError body = ApiError.of(status.value(), status.getReasonPhrase(), message, path(request));
        return ResponseEntity.status(status).body(body);
    }

    private String path(WebRequest request) {
        return request.getDescription(false).replace("uri=", "");
    }
}
