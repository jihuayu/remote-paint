-- Historical v1 schema, retained to verify actual on-disk migration.
PRAGMA foreign_keys=ON;
BEGIN EXCLUSIVE;
CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE sessions(session_id TEXT PRIMARY KEY,tenant TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),UNIQUE(session_id,tenant)) STRICT;
CREATE TABLE operations(operation_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,tenant TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),UNIQUE(operation_id,tenant),FOREIGN KEY(session_id,tenant) REFERENCES sessions(session_id,tenant)) STRICT;
CREATE TABLE bindings(tenant TEXT NOT NULL,key_hash TEXT NOT NULL,operation_id TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),PRIMARY KEY(tenant,key_hash),FOREIGN KEY(operation_id,tenant) REFERENCES operations(operation_id,tenant)) STRICT;
INSERT INTO metadata VALUES('format','remote-paint-session-ledger-v1'),('revision','1');
PRAGMA user_version=1;
COMMIT;
