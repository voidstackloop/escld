package com.escld.backend.experiment;

import java.util.List;
import java.util.UUID;

/**
 * Deterministic A/B bucketing: the same user always lands in the same
 * variant for a given experiment, computed fresh on every call from a stable
 * hash rather than stored in a table — nothing to write, nothing to read,
 * nothing that can drift out of sync with the assignment logic itself.
 * String.hashCode() is specified exactly by the JDK (not JVM-instance- or
 * platform-dependent), so this is stable across restarts and deploys.
 */
public final class ExperimentAssignment {

    private ExperimentAssignment() {}

    public static String assign(UUID userId, String experimentId, List<String> variants) {
        int bucket = Math.floorMod((userId.toString() + ":" + experimentId).hashCode(), variants.size());
        return variants.get(bucket);
    }
}
