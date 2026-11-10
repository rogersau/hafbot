-- hafbot:migration {"phase":"expand"}

-- WARDOGS preparation. No approved origins, secrets, or network enablement.
CREATE TABLE wardogs_targets (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0 AND slot < 5),
  generation INTEGER NOT NULL CHECK (generation > 0),
  data TEXT NOT NULL,
  UNIQUE (guild_id, slot)
);
CREATE TABLE wardogs_budgets (
  origin TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  next_at_ms INTEGER NOT NULL,
  data TEXT NOT NULL
);
