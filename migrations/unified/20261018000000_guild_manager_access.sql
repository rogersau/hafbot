-- hafbot:migration {"phase":"expand"}
ALTER TABLE guild_rbac_settings ADD COLUMN manage_server_admin_enabled INTEGER CHECK (manage_server_admin_enabled IN (0, 1)) NOT NULL DEFAULT 1;
