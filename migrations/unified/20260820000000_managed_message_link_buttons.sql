-- hafbot:migration {"phase":"expand"}
ALTER TABLE managed_messages
  ADD COLUMN buttons_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE managed_message_drafts
  ADD COLUMN buttons_json TEXT NOT NULL DEFAULT '[]';
