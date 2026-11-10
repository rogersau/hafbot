-- hafbot:migration {"phase":"expand"}

ALTER TABLE admin_feedback ADD COLUMN page_label TEXT;
ALTER TABLE admin_feedback ADD COLUMN error_code TEXT;
