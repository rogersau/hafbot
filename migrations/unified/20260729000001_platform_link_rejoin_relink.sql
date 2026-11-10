-- hafbot:migration {"phase":"expand"}

ALTER TABLE platform_link_configs
  ADD COLUMN require_relink_on_rejoin INTEGER NOT NULL DEFAULT 0;

ALTER TABLE platform_links
  ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
