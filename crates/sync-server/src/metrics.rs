use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct Metrics {
    active_sessions: AtomicU64,
    active_rooms: AtomicU64,
    accepted_updates: AtomicU64,
    rejected_frames: AtomicU64,
    slow_consumers: AtomicU64,
    room_reconstructions: AtomicU64,
    request_sequence: AtomicU64,
}

impl Metrics {
    pub fn session_opened(&self) {
        self.active_sessions.fetch_add(1, Ordering::Relaxed);
    }

    pub fn session_closed(&self) {
        self.active_sessions.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn room_opened(&self) {
        self.active_rooms.fetch_add(1, Ordering::Relaxed);
        self.room_reconstructions.fetch_add(1, Ordering::Relaxed);
    }

    pub fn room_closed(&self) {
        self.active_rooms.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn update_accepted(&self) {
        self.accepted_updates.fetch_add(1, Ordering::Relaxed);
    }

    pub fn frame_rejected(&self) {
        self.rejected_frames.fetch_add(1, Ordering::Relaxed);
    }

    pub fn slow_consumer(&self) {
        self.slow_consumers.fetch_add(1, Ordering::Relaxed);
    }

    pub fn next_request_id(&self) -> u64 {
        self.request_sequence.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn render(&self) -> String {
        let values = [
            (
                "neoseq_sync_active_sessions",
                "gauge",
                self.active_sessions.load(Ordering::Relaxed),
            ),
            (
                "neoseq_sync_active_rooms",
                "gauge",
                self.active_rooms.load(Ordering::Relaxed),
            ),
            (
                "neoseq_sync_updates_accepted_total",
                "counter",
                self.accepted_updates.load(Ordering::Relaxed),
            ),
            (
                "neoseq_sync_frames_rejected_total",
                "counter",
                self.rejected_frames.load(Ordering::Relaxed),
            ),
            (
                "neoseq_sync_slow_consumers_total",
                "counter",
                self.slow_consumers.load(Ordering::Relaxed),
            ),
            (
                "neoseq_sync_room_reconstructions_total",
                "counter",
                self.room_reconstructions.load(Ordering::Relaxed),
            ),
        ];
        let mut output = String::new();
        for (name, kind, value) in values {
            output.push_str(&format!("# TYPE {name} {kind}\n{name} {value}\n"));
        }
        output
    }
}
