package com.escld.backend.controllers;

import java.util.Optional;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.escld.backend.dto.LiveViewerCountResponse;
import com.escld.backend.dto.PostResponse;
import com.escld.backend.dto.StartLiveStreamRequest;
import com.escld.backend.dto.StreamKeyResponse;
import com.escld.backend.entities.Post;
import com.escld.backend.entities.User;
import com.escld.backend.live.LiveStreamService;
import com.escld.backend.live.LiveViewerPresenceService;
import com.escld.backend.live.StreamKeyService;
import com.escld.backend.mappers.PostMapper;
import com.escld.backend.services.UserService;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;

/**
 * Backs the "go live" setup flow: the frontend calls this to get an
 * rtmp://.../live/<streamKey> URL to hand to an encoder (OBS, etc.), to
 * announce a stream with a title/description (which is what actually makes
 * it show up in the feed — see LiveStreamService), and to end one. The RTMP
 * server (see rtmp/) never talks to this backend directly — it validates a
 * stream key, and separately checks for an announced stream, by querying
 * Postgres itself (same "Rust services own their own DB read" pattern
 * ws-sfu already uses for Cognito-sub resolution, see
 * ws-sfu/src/store/postgres.rs).
 */
@RestController
@RequestMapping("/api/v1/live")
@RequiredArgsConstructor
public class LiveController {

    private final StreamKeyService streamKeyService;
    private final LiveStreamService liveStreamService;
    private final LiveViewerPresenceService liveViewerPresenceService;
    private final UserService userService;
    private final PostMapper postMapper;

    /**
     * Generates a new stream key, replacing any existing one. Deliberately a
     * single "regenerate" operation rather than separate create/rotate
     * endpoints — requesting again when a key already exists is exactly
     * "rotate" (the old key stops working immediately), matching every real
     * streaming platform's own key-management UX.
     */
    @PostMapping("/stream-key")
    public StreamKeyResponse regenerateStreamKey(@AuthenticationPrincipal Jwt jwt) {
        UUID userId = userService.getOrProvisionByCognitoSub(jwt).getId();
        return new StreamKeyResponse(streamKeyService.regenerate(userId));
    }

    /**
     * Announces a stream with a title/description before the caller starts
     * their encoder — see LiveStreamService's own doc for why this has to
     * happen first (the RTMP server refuses to accept a publish for a user
     * with no announced stream).
     */
    @PostMapping("/streams")
    @ResponseStatus(HttpStatus.CREATED)
    public PostResponse startStream(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody StartLiveStreamRequest request) {
        User user = userService.getOrProvisionByCognitoSub(jwt);
        Post post = liveStreamService.start(user.getId(), request);
        return postMapper.toResponse(post, user, false);
    }

    /** Ends the caller's own active stream — see LiveStreamService's own doc
     * on why there's no path parameter for which one. */
    @PostMapping("/streams/end")
    public PostResponse endStream(@AuthenticationPrincipal Jwt jwt) {
        User user = userService.getOrProvisionByCognitoSub(jwt);
        Post post = liveStreamService.end(user.getId());
        return postMapper.toResponse(post, user, false);
    }

    /**
     * The caller's own currently-active stream, if any — lets the frontend
     * (Live.tsx) show accurate state on page load, closing a real gap: with
     * no way to ask this, a user who left the Go Live page mid-stream and
     * came back had no way to know except by attempting to start again and
     * reading the resulting "already live" error. 204 (not a null-bodied
     * 200) when nothing is live, matching UserController's own
     * ResponseEntity convention for "there's genuinely nothing here."
     */
    @GetMapping("/streams/me")
    public ResponseEntity<PostResponse> activeStream(@AuthenticationPrincipal Jwt jwt) {
        User user = userService.getOrProvisionByCognitoSub(jwt);
        Optional<Post> active = liveStreamService.getActiveStream(user.getId());
        return active
                .map(post -> ResponseEntity.ok(postMapper.toResponse(post, user, false)))
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    /**
     * Called every ~15s by a viewer actually watching a live stream (see
     * frontend/src/lib/live.ts) — this is the only signal this backend has
     * for "someone is watching," since HLS playback itself is just periodic
     * HTTP GETs against CloudFront with no persistent connection here. Not
     * scoped to only accept a currently-LIVE postId: an authenticated user
     * pinging an arbitrary id just writes one small, TTL-bounded Redis key
     * (see LiveViewerPresenceService) rather than anything expensive or
     * unbounded, so the extra DB read to validate liveStatus on every single
     * heartbeat wasn't judged worth it.
     */
    @PostMapping("/streams/{postId}/heartbeat")
    public LiveViewerCountResponse heartbeat(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID postId) {
        User user = userService.getOrProvisionByCognitoSub(jwt);
        return new LiveViewerCountResponse(liveViewerPresenceService.recordHeartbeat(postId, user.getId()));
    }

    /** Read-only viewer count — used for an initial render before a viewer's own first heartbeat lands. */
    @GetMapping("/streams/{postId}/viewers")
    public LiveViewerCountResponse viewerCount(@PathVariable UUID postId) {
        return new LiveViewerCountResponse(liveViewerPresenceService.getViewerCount(postId));
    }
}
