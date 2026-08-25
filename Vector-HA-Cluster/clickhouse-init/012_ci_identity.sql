ALTER TABLE default.registered_agents
    ADD COLUMN IF NOT EXISTS ci_id String DEFAULT '' AFTER host_id;

ALTER TABLE default.ingest_chunks
    ADD COLUMN IF NOT EXISTS ci_id String DEFAULT '' AFTER host_id;

ALTER TABLE default.raw_chunk_vault
    ADD COLUMN IF NOT EXISTS ci_id String DEFAULT '' AFTER host_id;
