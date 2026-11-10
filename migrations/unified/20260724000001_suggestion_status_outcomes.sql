-- hafbot:migration {"phase":"expand"}

ALTER TABLE suggestion_status_events ADD COLUMN outcome_json TEXT;
