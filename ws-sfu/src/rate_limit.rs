use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::{Arc, RwLock};

use governor::clock::DefaultClock;
use governor::state::{InMemoryState, NotKeyed};
use governor::{Quota, RateLimiter as GovernorLimiter};

pub type Limiter = GovernorLimiter<NotKeyed, InMemoryState, DefaultClock>;

/// One token-bucket limiter per connected socket, created lazily and torn
/// down on disconnect (`remove`) so this doesn't grow unbounded over the
/// process lifetime. Uses a plain blocking `RwLock` rather than an async one
/// - every critical section here is a single map lookup/insert, short enough
/// that holding a blocking lock across it is the simpler, cheaper choice.
pub struct RateLimiters {
    messages_send: RwLock<HashMap<String, Arc<Limiter>>>,
    /// A separate bucket from `messages_send` — deliberately distinct so
    /// chatting in a live stream never eats into a user's DM-sending
    /// allowance, and vice versa (see `ws/live.rs::send_chat`).
    live_chat_send: RwLock<HashMap<String, Arc<Limiter>>>,
}

impl RateLimiters {
    pub fn new() -> Self {
        Self {
            messages_send: RwLock::new(HashMap::new()),
            live_chat_send: RwLock::new(HashMap::new()),
        }
    }

    /// Burst of 5, refilling at 1/sec - a reasonable ceiling for a human
    /// typing chat messages, well below anything a legitimate client needs.
    pub fn messages_send(&self, socket_id: &str) -> Arc<Limiter> {
        if let Some(limiter) = self.messages_send.read().unwrap().get(socket_id) {
            return limiter.clone();
        }
        let quota = Quota::per_second(NonZeroU32::new(1).unwrap()).allow_burst(NonZeroU32::new(5).unwrap());
        let limiter = Arc::new(GovernorLimiter::direct(quota));
        self.messages_send
            .write()
            .unwrap()
            .insert(socket_id.to_string(), limiter.clone());
        limiter
    }

    /// Burst of 8, refilling at 2/sec - a live chat is a faster-moving,
    /// more disposable stream of short messages than a DM, so this allows
    /// noticeably more throughput than `messages_send` while still being
    /// well below anything a legitimate client needs.
    pub fn live_chat_send(&self, socket_id: &str) -> Arc<Limiter> {
        if let Some(limiter) = self.live_chat_send.read().unwrap().get(socket_id) {
            return limiter.clone();
        }
        let quota = Quota::per_second(NonZeroU32::new(2).unwrap()).allow_burst(NonZeroU32::new(8).unwrap());
        let limiter = Arc::new(GovernorLimiter::direct(quota));
        self.live_chat_send
            .write()
            .unwrap()
            .insert(socket_id.to_string(), limiter.clone());
        limiter
    }

    pub fn remove(&self, socket_id: &str) {
        self.messages_send.write().unwrap().remove(socket_id);
        self.live_chat_send.write().unwrap().remove(socket_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_chat_send_allows_exactly_its_burst_then_rejects() {
        let limiters = RateLimiters::new();
        let limiter = limiters.live_chat_send("socket-1");

        for _ in 0..8 {
            assert!(limiter.check().is_ok(), "burst of 8 should all succeed");
        }
        assert!(limiter.check().is_err(), "the 9th call within the same instant should be rejected");
    }

    /// The real point of having two separate buckets, not one shared one —
    /// exhausting a socket's live-chat burst must not touch its DM-sending
    /// allowance, and vice versa.
    #[test]
    fn live_chat_send_and_messages_send_are_independent_buckets() {
        let limiters = RateLimiters::new();
        let live_limiter = limiters.live_chat_send("socket-1");
        for _ in 0..8 {
            assert!(live_limiter.check().is_ok());
        }
        assert!(live_limiter.check().is_err(), "live chat burst should now be exhausted");

        // messages_send for the SAME socket id must still have its own,
        // untouched allowance.
        let dm_limiter = limiters.messages_send("socket-1");
        assert!(dm_limiter.check().is_ok(), "messages_send must not share live_chat_send's exhausted bucket");
    }

    #[test]
    fn remove_clears_both_buckets_so_a_fresh_limiter_is_created_afterward() {
        let limiters = RateLimiters::new();
        let limiter = limiters.live_chat_send("socket-1");
        for _ in 0..8 {
            assert!(limiter.check().is_ok());
        }
        assert!(limiter.check().is_err());

        limiters.remove("socket-1");

        // A brand-new limiter for the same socket id has its own fresh
        // burst allowance, not the exhausted one `remove` should have
        // dropped.
        let fresh = limiters.live_chat_send("socket-1");
        assert!(fresh.check().is_ok(), "remove() should drop the exhausted limiter, not leave it in the map");
    }
}
