package com.escld.backend.live;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;

import com.escld.backend.metrics.EmfMetrics;

import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import lombok.extern.slf4j.Slf4j;

/**
 * Real-time concurrent-viewer tracking for live streams — a Redis sorted
 * set per post (`live:viewers:<postId>`), member = viewer's user id, score =
 * epoch millis of their most recent heartbeat. There's no persistent
 * connection to key viewer presence off the way a websocket would give for
 * free: HLS playback is just periodic HTTP GETs against CloudFront,
 * completely invisible to this backend. So this exists purely because the
 * frontend pings a heartbeat endpoint every HEARTBEAT_INTERVAL_MS while a
 * live `<video>` is actually mounted (see frontend/src/lib/live.ts and
 * post-card.tsx) — an expiring presence signal is the only mechanism
 * available, not a design preference. Reuses the same shared Redis
 * connection/cluster as TrendingScoreClient (see TrendingConfig's own doc)
 * — a different key/command shape against the same store, not a separate
 * one.
 */
@Slf4j
@Component
public class LiveViewerPresenceServiceImpl implements LiveViewerPresenceService {

    // Two full client heartbeat intervals (15s, see live.ts) — long enough
    // that one delayed/dropped ping doesn't flicker a real viewer out of the
    // count, short enough that someone who actually closed the tab drops out
    // within half a minute rather than lingering.
    private static final long STALE_AFTER_MILLIS = Duration.ofSeconds(30).toMillis();
    // Safety-net TTL on the whole sorted-set key, well past STALE_AFTER —
    // guarantees an entirely abandoned stream's key disappears from Redis
    // even if this process never explicitly cleans it up (a crash between
    // "stream ended" and calling clear(), an encoder that vanishes with the
    // app never calling end()).
    private static final long KEY_TTL_SECONDS = Duration.ofMinutes(5).toSeconds();

    private final StatefulRedisConnection<String, String> connection;
    private final EmfMetrics emfMetrics;

    public LiveViewerPresenceServiceImpl(StatefulRedisConnection<String, String> trendingRedisConnection, EmfMetrics emfMetrics) {
        this.connection = trendingRedisConnection;
        this.emfMetrics = emfMetrics;
    }

    @Override
    public int recordHeartbeat(UUID postId, UUID viewerId) {
        try {
            RedisCommands<String, String> sync = connection.sync();
            String key = viewersKey(postId);
            long now = Instant.now().toEpochMilli();

            sync.zadd(key, (double) now, viewerId.toString());
            sync.expire(key, KEY_TTL_SECONDS);
            int count = trimAndCount(sync, key, now);
            updatePeakIfHigher(sync, postId, count);

            emfMetrics.increment("live_viewer_heartbeat_total", Map.of("result", "success"));
            return count;
        } catch (Exception e) {
            log.warn("Failed to record live viewer heartbeat for post {}", postId, e);
            emfMetrics.increment("live_viewer_heartbeat_total", Map.of("result", "failure"));
            // 0, not the last-known count — a Redis failure shouldn't make a
            // stale/wrong number look authoritative to the viewer.
            return 0;
        }
    }

    @Override
    public int getViewerCount(UUID postId) {
        try {
            RedisCommands<String, String> sync = connection.sync();
            return trimAndCount(sync, viewersKey(postId), Instant.now().toEpochMilli());
        } catch (Exception e) {
            log.warn("Failed to read live viewer count for post {}", postId, e);
            return 0;
        }
    }

    @Override
    public int getPeakViewerCount(UUID postId) {
        try {
            String value = connection.sync().get(peakKey(postId));
            return value == null ? 0 : Integer.parseInt(value);
        } catch (Exception e) {
            log.warn("Failed to read peak live viewer count for post {}", postId, e);
            return 0;
        }
    }

    @Override
    public void clear(UUID postId) {
        try {
            connection.sync().del(viewersKey(postId), peakKey(postId));
        } catch (Exception e) {
            log.warn("Failed to clear live viewer presence for post {}", postId, e);
        }
    }

    private int trimAndCount(RedisCommands<String, String> sync, String key, long now) {
        sync.zremrangebyscore(key, Double.NEGATIVE_INFINITY, now - STALE_AFTER_MILLIS);
        Long count = sync.zcard(key);
        return count == null ? 0 : count.intValue();
    }

    // Not atomic (a GET then a conditional SET) — an occasional off-by-one
    // race under this is an acceptable trade for not depending on Redis's
    // newer `SET ... GT` option (added in 7.0; this app doesn't pin an
    // engine version) for what is ultimately a display statistic, not a
    // ranking input.
    private void updatePeakIfHigher(RedisCommands<String, String> sync, UUID postId, int count) {
        String key = peakKey(postId);
        String current = sync.get(key);
        int currentPeak = current == null ? 0 : Integer.parseInt(current);
        if (count > currentPeak) {
            sync.set(key, String.valueOf(count));
        }
    }

    private static String viewersKey(UUID postId) {
        return "live:viewers:" + postId;
    }

    private static String peakKey(UUID postId) {
        return "live:viewers:peak:" + postId;
    }
}
