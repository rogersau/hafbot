-- hafbot:migration {"phase":"expand"}

CREATE TABLE one_time_tokens (
  nonce TEXT PRIMARY KEY NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER NOT NULL
);

CREATE INDEX one_time_tokens_expires_at ON one_time_tokens(expires_at_ms);
