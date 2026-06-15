-- The session/message cache now lives in the SyncHub Durable Object's SQLite. D1 keeps only
-- settings (encrypted BYO key) and activity (idle-stop clock).

DROP TABLE IF EXISTS session_messages;
DROP TABLE IF EXISTS sessions;
