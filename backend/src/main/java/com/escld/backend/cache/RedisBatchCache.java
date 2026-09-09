package com.escld.backend.cache;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.stereotype.Component;

import lombok.RequiredArgsConstructor;

/**
 * Batch equivalent of @Cacheable for bulk findAllById-shaped reads. Spring's
 * Cache interface (confirmed directly against the resolved spring-data-redis
 * jar) has no multi-get primitive — @Cacheable can only cache the return
 * value under one key, which for a bulk lookup would mean one cache entry
 * per distinct *combination* of requested ids. Useless for something like a
 * feed page, where every request asks for a different candidate set drawn
 * from an unbounded id space.
 *
 * Deliberately shares its keyspace with RedisCacheManager-driven @Cacheable
 * caches (see CacheConfig) by reconstructing the exact same "<cacheName>::
 * <key>" format Spring Data Redis's CacheKeyPrefix.simple() produces — so a
 * single-key @CacheEvict on, say, "postsById" (see PostServiceImpl) also
 * invalidates any batch-cached copy of that same post, and this class never
 * needs an eviction path of its own. RedisBatchCacheTest verifies this
 * against a real Redis rather than trusting it as an assumption.
 *
 * Callers are responsible for only returning cacheable values from `loader`
 * — e.g. FeedServiceImpl's postsById loader filters out soft-deleted posts
 * before returning them, since PostServiceImpl#getById's own @Cacheable
 * never caches a soft-deleted post (it throws instead) and this class must
 * preserve that same invariant to avoid a deleted post becoming readable
 * again through the shared cache key.
 */
@Component
@RequiredArgsConstructor
public class RedisBatchCache {

    private final RedisTemplate<String, Object> batchCacheRedisTemplate;

    /**
     * Returns one value per id actually found — an id the loader doesn't
     * return a value for is simply absent from the result, matching
     * CrudRepository#findAllById's own "skip missing ids" contract. Cache
     * hits are read via a single MGET; any misses are resolved in one batch
     * loader call and written back individually with the given TTL.
     */
    public <K, V> Map<K, V> getAll(
            String cacheName,
            Collection<K> ids,
            Function<K, String> keyFn,
            Duration ttl,
            Function<Collection<K>, Map<K, V>> loader) {
        if (ids.isEmpty()) {
            return Map.of();
        }

        List<K> idList = new ArrayList<>(new LinkedHashSet<>(ids));
        List<String> redisKeys = idList.stream().map(id -> cacheName + "::" + keyFn.apply(id)).toList();

        List<Object> cachedValues = batchCacheRedisTemplate.opsForValue().multiGet(redisKeys);

        Map<K, V> result = new HashMap<>();
        List<K> missingIds = new ArrayList<>();
        for (int i = 0; i < idList.size(); i++) {
            Object cached = cachedValues == null ? null : cachedValues.get(i);
            if (cached != null) {
                @SuppressWarnings("unchecked")
                V value = (V) cached;
                result.put(idList.get(i), value);
            } else {
                missingIds.add(idList.get(i));
            }
        }

        if (!missingIds.isEmpty()) {
            Map<K, V> loaded = loader.apply(missingIds);
            result.putAll(loaded);
            // Individual SET-with-TTL calls, not MSET+EXPIRE — MSET has no
            // per-key TTL support, and a separate EXPIRE call per key after
            // an MSET would leave a brief window where a freshly-written key
            // has no expiry at all if the process died between the two
            // calls. This is the miss path only (rarer than the MGET hit
            // path above), so batching it isn't worth that risk.
            for (Map.Entry<K, V> entry : loaded.entrySet()) {
                String redisKey = cacheName + "::" + keyFn.apply(entry.getKey());
                batchCacheRedisTemplate.opsForValue().set(redisKey, entry.getValue(), ttl);
            }
        }

        return result;
    }
}
