-- Add request-level idempotency for bet creation (idempotent).
CREATE TABLE IF NOT EXISTS bet_idempotency_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(128) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    bet_ids INTEGER[],
    response_json JSONB,
    http_status SMALLINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_bet_idempotency_user_key UNIQUE (user_id, idempotency_key),
    CONSTRAINT bet_idempotency_status_check CHECK (status IN ('pending', 'created', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_bet_idempotency_user_created
    ON bet_idempotency_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bet_idempotency_status
    ON bet_idempotency_requests (status);
