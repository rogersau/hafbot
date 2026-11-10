-- hafbot:migration {"phase":"data","previousWorkerCompatible":true}
-- Reference data formerly installed by the archived Evidence Vault migration.
INSERT OR IGNORE INTO identity_patterns
  (id, platform, pattern, capture_group, position, disabled, created_at_ms)
VALUES
  ('seed-steam-profile-url', 'steam', 'steamcommunity\.com/profiles/(\d{17})', 1, 10, 0, 0),
  ('seed-steam-id64', 'steam', '\b(7656119\d{10})\b', 1, 20, 0, 0),
  ('seed-discord-mention', 'discord', '<@!?(\d{17,20})>', 1, 30, 0, 0),
  ('seed-discord-id', 'discord', '\b(\d{17,20})\b', 1, 40, 0, 0),
  ('seed-xbox-xuid', 'xbox', '\b(\d{16})\b', 1, 50, 0, 0),
  ('seed-cftools-url', 'cftools', 'cftools\.(?:cloud|com)/(?:profile|users?)/(?:steam/)?([A-Za-z0-9_-]+)', 1, 60, 0, 0);
