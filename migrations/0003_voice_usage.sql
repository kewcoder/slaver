-- Voice transcription cost tracking (seconds of audio).
ALTER TABLE usage_logs ADD COLUMN audio_seconds REAL NOT NULL DEFAULT 0;
