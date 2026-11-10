-- hafbot:migration {"phase":"expand"}

-- Rich offering lifecycle projection.  commerce_offerings.status remains
-- intentionally backwards compatible (draft/active/archived); this table is
-- the authority for seller-facing published/unpublished/repair/retiring and
-- suspended states.
CREATE TABLE commerce_offering_lifecycles (
  offering_id TEXT PRIMARY KEY NOT NULL,
  connected_account_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('draft', 'published', 'unpublished', 'repair_required', 'retiring', 'archived', 'suspended')
  ),
  terms_version TEXT,
  included_benefits_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(included_benefits_json)),
  support_contact TEXT,
  role_manageable INTEGER NOT NULL DEFAULT 0 CHECK (role_manageable IN (0, 1)),
  repair_deadline_at_ms INTEGER,
  retire_at_ms INTEGER,
  published_at_ms INTEGER,
  archived_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((state = 'archived') = (archived_at_ms IS NOT NULL)),
  CHECK (state <> 'retiring' OR retire_at_ms IS NOT NULL)
);
CREATE INDEX commerce_offering_lifecycles_seller_state
  ON commerce_offering_lifecycles (connected_account_id, state, updated_at_ms);
CREATE INDEX commerce_offering_lifecycles_guild_state
  ON commerce_offering_lifecycles (guild_id, state);
