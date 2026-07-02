ALTER TABLE default.windows_system_logs
    ADD COLUMN IF NOT EXISTS process_name String DEFAULT '' AFTER process_path,
    ADD COLUMN IF NOT EXISTS file_path String DEFAULT '' AFTER target_filename,
    ADD COLUMN IF NOT EXISTS registry_key String DEFAULT '' AFTER target_object;
