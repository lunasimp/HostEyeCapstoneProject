# HostEye Use Case Progress

This tracker records implementation-level verification. Report 5 is reserved for system and end-to-end flow testing.

| Use case | Status | Verification | Branch / commit |
|---|---|---|---|
| UC-01 - Dashboard overview | Implemented | 6 integration tests passed | `uc/UC-01-dashboard-overview` / `fa95e70` |
| UC-02 - Monitor log collection status | Implemented | 6 UC-02 integration tests passed; full dashboard API suite 12/12 passed | `uc/UC-02-collection-status` |
| UC-03 - Search and filter logs | Implemented | 6 automated tests passed; 1 real ClickHouse Docker integration test passed; full default suite 18 passed / 1 integration skip; desktop/mobile browser QA passed | `uc/UC-03-log-search` |
| UC-06 - View alerts | Implemented | 5 mock/API tests passed; real ClickHouse Docker integration 6/6 passed; full default suite 23 passed / 2 optional integration skips; desktop/mobile browser QA passed | `uc/UC-06-alert-list` |
| UC-07 - View alert details | Implemented | 9 alert API/UI tests passed; full default suite 27 passed / 2 optional integration skips; real ClickHouse event and failed-logon detail flows passed; desktop/mobile browser QA passed | `uc/UC-07-alert-detail` |
| UC-08 - Search and filter alerts | Implemented | 12 alert API/UI tests passed; 2 real ClickHouse alert integration flows passed; full default suite 30 passed / 3 optional integration skips; desktop/mobile browser QA passed | `uc/UC-08-alert-filter` |
| UC-09 - Configure Dynamic Logs | Implemented | 5 API/control-plane/UI tests passed; full default Dashboard API suite 35 passed / 3 optional integration skips; live control-plane read and desktop/mobile browser QA passed | `uc/UC-09-dynamic-log-config` |
| UC-10 - Select log data fields | Implemented | 7 Dynamic Config API/UI tests passed; full Dashboard API suite 37 passed / 3 optional integration skips; Rust source parse and desktop/mobile browser QA passed | `uc/UC-10-log-field-selection` |
| UC-11 - Preview Dynamic Logs configuration | Implemented | 16 focused tests passed; full Dashboard API suite 40 passed / 3 optional integration skips; live preview and all-time Dashboard browser QA passed | `uc/UC-11-config-preview` |
| UC-12 - Assign Dynamic Logs configuration | Implemented | 11 Dynamic Config tests passed; full Dashboard API suite 42 passed / 3 optional integration skips; isolated signed apply and desktop/mobile browser QA passed | `uc/UC-12-config-assignment` |
| UC-13 - View Dynamic Logs configuration status | Implemented | UC-13 API status test passed; full Dashboard API suite 43 passed / 3 optional integration skips; Rust tests 2/2 passed; isolated success/failure flow and desktop/mobile browser QA passed | `uc/UC-13-config-status` |
| UC-14 - View log-loss statistics | Implemented | 3 focused API/UI tests passed; full Dashboard API suite 46 passed / 3 optional integration skips; HostEyeShipper tests 2/2 passed including real quota deletion; control plane cargo check passed; desktop/mobile browser QA passed | `uc/UC-14-log-loss-statistics` |
| UC-15 - View log-loss ratio | Implemented | 2 focused UC-15 API/UI tests passed; full Dashboard API suite 48 passed / 3 optional integration skips; HostEyeShipper quota tests and control plane cargo check passed | uc/UC-15-log-loss-ratio |
| UC-16 - View log-loss causes | Implemented | 2 focused UC-16 API/UI tests passed; full Dashboard API suite 50 passed / 3 optional integration skips; live ClickHouse cause flow and desktop/mobile browser QA passed | uc/UC-16-log-loss-causes |
| UC-17 - View collection interruption history | Implemented | 2 focused UC-17 API/UI tests passed; full Dashboard API suite 52 passed / 3 optional integration skips; live ClickHouse gap/recovery flow and desktop/mobile browser QA passed | uc/UC-17-collection-interruption-history |

## UC-02 verified behavior

- Combines enrollment, latest Windows log activity, and HostEyeShipper runtime metrics per endpoint.
- Shows activity levels and collection health, including upload failure, spool backlog, stale, disabled, and no-data states.
- Keeps registered endpoints visible before their first log arrives.
- Exposes Host Inventory, registered agent, jitter, and chunk-monitor API routes used by the dashboard.
- Returns explicit validation, ClickHouse query failure, and ClickHouse outage responses without demo data.

## UC-03 verified behavior

- Searches log content across message, command line, process, raw log, user, DNS, file, registry object, and network-address fields.
- Combines keyword, host, channel, Event ID, and time-range filters; keyword is optional.
- Supports bounded pagination with total count and explicit applied-filter metadata.
- Provides a dedicated Dashboard search page with filter, reset, previous, and next controls.
- Rejects malformed filters and reports ClickHouse query failures or outages without fallback data.
- Passed a real Docker integration flow that inserted temporary ClickHouse rows, queried them through the Dashboard API, and removed the test rows.
- Passed desktop/mobile browser QA; stale search responses cannot overwrite newer filtered results.

## UC-06 verified behavior

- Derives alerts from real endpoint telemetry for process tampering, remote-thread creation, account creation/deletion, suspicious PowerShell, Defender findings, and failed-logon bursts.
- Returns severity totals, bounded pagination, and applied host/time filters without fabricated fallback alerts.
- Provides a dedicated Dashboard Alerts page with severity KPI cards, a paginated alert table, and stale-response protection.
- Keeps alert details and alert filtering out of scope for UC-07 and UC-08.
- Passed a real Docker integration flow that inserted temporary ClickHouse rows, verified three expected alerts and one excluded benign event, and removed all test rows.
- Passed desktop/mobile browser QA with no horizontal overflow or console errors.

## UC-07 verified behavior

- Resolves single-event alerts by idempotency key and failed-logon alerts by their deterministic five-minute window identifier.
- Returns severity, detection time, host, rule, user/source context, technical evidence, and bounded related-log records.
- Marks the triggering event as primary evidence and supplies nearby host telemetry as context; grouped authentication alerts return the exact failed-logon evidence window.
- Provides an accessible alert-detail dialog with stale-request protection, keyboard/backdrop close behavior, and responsive evidence tables.
- Correctly preserves ClickHouse timestamps without applying an unintended local-timezone offset.
- Passed real ClickHouse flows for a Sysmon process-tampering alert and a six-event failed-logon alert; all temporary rows were removed.
- Passed desktop/mobile browser QA with no horizontal page overflow or console errors.


## UC-08 verified behavior

- Filters both single-event and grouped failed-logon alerts by keyword, severity, status, host, and time range.
- Applies the same filters to the alert rows, severity summary, total count, and pagination metadata.
- Validates malformed severity, status, host, keyword, date, and pagination values before querying ClickHouse.
- Provides a responsive Dashboard filter form with Apply and Reset controls while retaining stale-response and alert-detail protections.
- Treats current telemetry-derived alerts as `new`; acknowledged or resolved filters deterministically return no matches until alert-state persistence is implemented by its dedicated use case.
- Passed real ClickHouse filtering with temporary PowerShell, Sysmon, and failed-logon telemetry; all temporary `uc08-docker-*` rows were removed.
- Passed desktop/mobile browser QA with working Apply/Reset behavior and no horizontal overflow.


## UC-09 verified behavior

- Publishes a canonical catalog for Windows Application, System, Security, Sysmon, PowerShell, WMI, and Microsoft Defender log types.
- Converts selected log types into deduplicated Windows Event Log channels and the corresponding Sysmon, PowerShell, and network sensor switches.
- Saves the configuration as a disabled, rollout-off Dynamic Config policy draft so UC-09 cannot deploy changes to endpoints prematurely.
- Validates required names, supported log types, targets, versions, and length limits before contacting the Dynamic Config control plane.
- Provides a responsive Dashboard form with safe duplicate-submit protection and explicit online, validation, save, and outage states.
- Keeps granular field selection in UC-10, preview in UC-11, and target assignment/application in UC-12.
- Replaces the legacy SOC gateway default with the current HostEye telemetry endpoint.
- Passed desktop/mobile browser QA with no horizontal overflow or console errors; validation QA did not mutate the live control-plane state.


## UC-10 verified behavior

- Publishes 11 selectable normalized telemetry fields matching the current Vector and ClickHouse schema.
- Maps user-facing hostname and username choices to the canonical endpoint fields `computer` and `user_name`.
- Keeps timestamp, hostname, Event ID, and channel selected as required routing fields while retaining agent/host identity, raw evidence, and idempotency data internally.
- Rejects empty, non-array, unknown, duplicate, and missing-required selections before contacting the Dynamic Config control plane.
- Persists the selected canonical fields in `config.vector.selected_fields`, renders them into `vector-dynamic.toml`, and validates them on the endpoint client with backward-compatible defaults for older policies.
- Keeps the policy disabled with rollout off; preview remains UC-11 and assignment/application remains UC-12.
- Passed desktop/mobile browser QA with optional-field selection, four locked required fields, no horizontal overflow, correct responsive columns, and no console errors.
- Rust syntax parsing passed; Cargo tests remain unavailable because `ed25519-dalek` is not present in the offline dependency cache.


## UC-11 verified behavior

- Builds a read-only preview from the current Dynamic Logs form without creating or updating a control-plane policy.
- Shows the configuration name, disabled draft state, selected log types, Windows channels, canonical field mappings, required fields, retained internal fields, and enabled sensors.
- Exposes the canonical policy JSON with rollout disabled and remains available when the Dynamic Config control plane is offline.
- Invalidates an existing preview whenever the form changes and rejects missing names, empty log selections, and invalid field selections before previewing.
- Distinguishes all-time ClickHouse rows from the active Dashboard time range and provides an explicit `All time` range option.
- Reports the latest telemetry timestamp and stale-data age so an ingestion outage is not mistaken for Dashboard truncation.
- Browser QA confirmed that previewing did not change the live policy count and that the all-time Overview displays all 2,682,431 available rows.


## UC-12 verified behavior

- Assigns only disabled Dynamic Logs drafts and preserves the reviewed canonical channels, fields, sensor switches, shipper settings, and other configuration values.
- Supports default-fleet, endpoint-group, and single-agent targets; agent and group assignments must reference identities already known to the control plane.
- Enables the policy and full target rollout atomically with a new version; staged percentage rollout remains outside this assignment use case.
- Keeps application asynchronous and truthful: the Dashboard reports that it is waiting until an endpoint polls the signed policy and sends an ACK.
- Displays the latest endpoint ACK, policy version, apply status, and apply message without claiming success before the endpoint responds.
- Passed an isolated end-to-end flow in which the Rust client selected the group policy, verified and applied the signed envelope, wrote the resulting state/config files, and ACKed policy version 2 as `applied`.
- Passed desktop and 390px mobile browser QA with no horizontal overflow, 44px mobile action control, and no console errors; no real endpoint group was modified.

## UC-13 verified behavior

- Records each endpoint poll, Agent version, Agent-reported current policy/version, desired policy/version, last configuration delivery, and latest ACK without overwriting prior ACK evidence.
- Distinguishes `Waiting for Agent poll`, `Sent; waiting for ACK`, `Applied`, `Rendered only`, `Apply failed`, and `No active policy` per endpoint.
- Resolves the assigned configuration with the same precedence as the control plane: Agent-specific policy, then group policy, then default policy; the newest version wins within a scope.
- Shows assigned configuration, delivery/apply state, current configuration, latest ACK, poll time, and ACK detail in a full-width responsive Dashboard table.
- Preserves backward compatibility for existing Dynamic Config state files through defaulted fields and updates the previously incomplete Cargo lockfile for reproducible signed-config builds.
- Passed the full Dashboard API suite with 43 tests passed and 3 optional integration skips; the UC-13 test covered applied, sent-waiting-ACK, pending-poll, and apply-failed states.
- Passed Rust tests 2/2 and an isolated real control-plane/client flow: one render-only Agent applied policy version 2 and then reported `up_to_date`; one Agent intentionally failed pre-apply validation and was reported as `apply_failed`.
- Passed desktop and 390px mobile browser QA with no page-level horizontal overflow or console errors; the wide status table uses contained horizontal scrolling on mobile.

## UC-14 verified behavior

- Persists cumulative events accepted into durable spool, successfully acknowledged by the gateway, and dropped when quota enforcement removes unsent chunks.
- Calculates exact pending-event counts from durable chunk filenames instead of estimating from spool bytes or file counts.
- Reports endpoint counters through the existing upload-admission path and stores the latest measurements in ClickHouse with an explicit metrics version.
- Shows per-host collected, ACKed, pending, at-risk, dropped, gateway-received, queue-pressure, coverage, and last-update fields.
- Treats events generated by Windows as unavailable because the current source does not expose a trustworthy total generated-event counter; the API and UI return no fabricated value.
- Keeps older Shippers and registered endpoints visible with explicit unavailable coverage until they report UC-14 counters.
- Passed the full Dashboard API suite with 46 tests passed and 3 optional integration skips; HostEyeShipper tests passed 2/2, including a quota flow that removed one 42-event unsent chunk and returned the exact dropped count.
- Control plane compilation passed after narrowing its storage module import and using the public ClickHouse query API.
- Passed desktop and 390px mobile browser QA with no page-level horizontal overflow or console errors; the wide per-host table remains contained by its table shell.

## UC-15 verified behavior

- Calculates the measured quota-loss ratio from Shipper-collected and quota-dropped event counters; it does not use the unavailable Windows-generated-event count.
- Persists cumulative collected and dropped counts by Windows Event Log channel and Event ID and reports them through the existing admission path with metrics version 2.
- Filters the ratio by host, Agent ID, channel, Event ID, and the selected metric-reporting time range.
- Marks older endpoints as unavailable and marks a filtered ratio as partial when a dropped chunk cannot be decoded for source attribution.
- Shows a weighted fleet ratio and per-host ratios in the Dashboard without inferring missing telemetry or performance data.
- Passed the full Dashboard API suite with 48 tests passed and 3 optional integration skips; HostEyeShipper compiled and quota tests passed; control plane cargo check passed.
## UC-16 verified behavior

- Classifies causes only from observed HostEyeShipper counters, upload transport results, spool pressure, registration/telemetry timestamps, and Agent chunk-error reports.
- Distinguishes quota eviction, spool write/read failures when explicitly reported, rejected or quarantined chunks, identity rejection, gateway failure, unreachable upload paths, spool pressure/full conditions, retry backlog, and silent endpoints.
- Returns `Insufficient evidence` when the endpoint has not reported enough telemetry instead of guessing a cause.
- Shows fleet cause counts plus a per-host cause and supporting evidence in the existing Log Loss workflow.
- Keeps the optional Agent error source backward-compatible when an older ClickHouse installation has not created that table yet.
- Passed the full Dashboard API suite with 50 tests passed and 3 optional integration skips. A live local ClickHouse flow classified both stale endpoints as `Agent/Shipper silent` from their old timestamps, and browser QA passed at the normal viewport and 390px mobile width without page-level overflow.

## UC-17 verified behavior

- Builds per-endpoint interruption history from observed Shipper metrics, admission decisions, gateway chunk receipts, and registration evidence.
- Marks an interruption only after the configurable evidence-silence threshold is exceeded; the Dashboard exposes 15-minute, 30-minute, 60-minute, and six-hour thresholds.
- Records the inferred start, recovery time when later evidence arrives, measured duration beyond the threshold, current status, Agent identity, and contributing evidence sources.
- Includes interruptions already active at the beginning of the selected range by loading the latest retained baseline signal before that range.
- Distinguishes recovered and ongoing interruptions and states explicitly that evidence silence is not proof that the Agent process stopped.
- Uses Unix-millisecond timestamps from ClickHouse to avoid local-timezone shifts and merges host names case-insensitively in interruption summaries.
- Passed the full Dashboard API suite with 52 tests passed and 3 optional integration skips. A live local ClickHouse flow returned one recovered and two ongoing evidence gaps at verification time.
- Passed desktop and 390px mobile browser QA with the UC-17 panel contained within the viewport, working threshold filtering, and no console errors.

## UC-18 verified behavior

- Reuses the exact pending-event and durable-spool counters reported by HostEyeShipper; it does not estimate retry backlog from gateway rows or Windows event totals.
- Exposes a dedicated retry-backlog API with per-host pending events, spool bytes/limit, retry count, retry-after delay, latest evidence time, and admission/transport evidence.
- Distinguishes endpoints waiting for connectivity, waiting for control-plane admission/backpressure, and endpoints that have reconnected and are still sending the retained backlog.
- Shows fleet totals and a responsive per-host retry-status table in the existing Log Loss workflow while omitting measured hosts whose pending count is zero.
- Passed the full Dashboard API suite with 54 tests passed and 3 optional integration skips; both focused UC-18 API/UI tests passed.
- Passed a live local ClickHouse/API flow against 3,493,714 all-time rows. No endpoint currently reported versioned pending counters in the selected range, so the API returned an explicit zero-backlog/zero-measured-host state without fabrication.
- Passed desktop and 390px mobile browser QA with no console errors and the retry panel contained within the viewport/table shell. The pre-existing one-pixel page-level mobile overflow remains unchanged.

## UC-19 verified behavior

- Generates active operational alerts only from measured HostEyeShipper loss counters, observed upload transport failures, and endpoint evidence silence; older endpoints do not receive fabricated ratio alerts.
- Emits `HE-LOSS-001` when the measured quota-loss ratio exceeds the selected threshold, `HE-CONN-001` when the Shipper cannot reach the upload path, and `HE-COLL-001` after more than 15 minutes without Agent, Shipper, gateway, or registration evidence.
- Supports 1%, 2%, 5%, and 10% loss thresholds and validates direct API threshold input before querying ClickHouse.
- Deduplicates host names case-insensitively per rule while retaining the newest observed alert evidence.
- Shows total, critical, high, affected-host counts, and a responsive evidence table in the existing Log Loss workflow.
- Passed both focused UC-19 tests and the full Dashboard API suite with 56 tests passed and 3 optional integration skips.
- Passed a live local ClickHouse/API flow with six active evidence-interruption alerts on six silent endpoints and no fabricated loss-ratio alert where versioned counters were unavailable.
- Passed desktop and 390px mobile browser QA with no console errors; the table stays in its scroll shell and the pre-existing one-pixel page overflow remains unchanged.

## UC-20 verified behavior

- Searches the log-loss host inventory by hostname, Agent ID, or Host ID and combines that search with the existing Agent, channel, Event ID, and time filters.
- Classifies each host from observed evidence as normal, collection interrupted, retry backlog, disconnected, at risk of data loss, or insufficient evidence; flags can overlap while the primary state uses a deterministic severity priority.
- Filters in the API before returning rows and validates unsupported risk-state values before querying ClickHouse.
- Shows the evidence-backed risk state as a dedicated per-host column and provides responsive machine-search and risk-state controls in the existing Log Loss workflow.
- Passed the full Dashboard API suite with 58 tests passed and 3 optional integration skips; the UC-02 registered-agent regression check and both focused UC-20 tests passed.
- Passed a live local ClickHouse/API flow with seven interrupted rows, no currently disconnected row, and two `bruh` search matches; no counters or states were fabricated for endpoints without versioned evidence.
- Passed desktop and 390px mobile browser QA: combined `bruh` plus interrupted filtering returned two matching rows, disconnected filtering showed the deterministic empty state, the table remained contained, and no console errors occurred. The pre-existing one-pixel mobile page overflow remains unchanged.

## UC-21 verified behavior

- Opens a per-machine detail dialog from the Log Loss host table and keeps the selected hostname, Agent ID, and Host ID visible for evidence correlation.
- Reports only measured HostEyeShipper counters for collected, ACKed, pending, at-risk, and quota-dropped events; Windows-generated or otherwise missing totals remain explicitly unavailable.
- Breaks measured counters down by Windows Event Log channel and Event ID, marks a source as affected only when the Shipper reports dropped events for that source, and preserves partial/unavailable coverage labels.
- Reuses the UC-17 operational-evidence timeline to show affected start/end times, total observed duration, individual interruptions, evidence sources, and ongoing/recovered state.
- Validates required machine and interruption-threshold input before querying ClickHouse and returns a deterministic not-found response for an unknown machine.
- Passed the full Dashboard API suite with 60 tests passed and 3 optional integration skips; focused UC-17/UC-21 regression tests passed after sharing the interruption data helper.
- Passed a live local ClickHouse/API flow for `BRUH`: one ongoing interruption was returned while loss/source counters remained explicitly unavailable because the endpoint has not reported versioned counters. Live verification also caught and fixed an invalid host predicate against `agent_chunk_errors`, whose schema has no `computer` column.
- Passed desktop and 390px mobile browser QA with a readable full-screen mobile dialog, contained evidence tables, working close behavior, no page-level overflow, and no console errors.

## UC-22 verified behavior

- Exports the current Log Loss view as a UTF-8 CSV report and applies the selected time range, global host, machine search, Agent ID, channel, Event ID, and risk-state filters.
- Includes report/filter metadata, machine and identity fields, collection/risk/cause states, measured Shipper counters, filtered channel/Event-ID counts and ratios, gateway evidence, coverage, and evidence notes.
- Limits one export to 5,000 rows, rejects unsupported formats before querying ClickHouse, protects dynamic cells from spreadsheet formula injection, and leaves unavailable counters blank instead of fabricating values.
- Uses the same evidence-backed host classification as the dashboard and remains compatible with the real `agent_chunk_errors` schema, which has no computer column.
- Passed the full Dashboard API suite with 62 tests passed and 3 optional integration skips; both focused UC-22 API/UI tests passed.
- Passed a live local ClickHouse/API export for `ST10-IDEM-20260805060022` in the interrupted state: one CSV data row, UTF-8 BOM, CSV content type, attachment filename, and explicitly blank unavailable endpoint counters.
- Passed desktop and 390px mobile browser QA: the CSV download completed, the UI reported the generated filename, the action re-enabled after completion, controls remained within the viewport, and no console errors occurred.

## UC-33 verified behavior

- Adds a dedicated Admin fleet-loss view and API while preserving the existing per-machine Log Loss workflow for User/analyst operations.
- Aggregates unique endpoints by stable Host/Agent identity and reports fleet host coverage, affected hosts, measured loss ratio, quota-dropped events, at-risk events, pending events, and overlapping operational risk flags.
- Separates the primary risk distribution from overlapping flags and ranks the Admin priority list by disconnected upload, collection interruption, measured loss risk, retry backlog, event counters, and latest evidence.
- Applies the global time/host scope plus Admin risk-state and top-10/25/50 focus filters; invalid filters are rejected before querying ClickHouse.
- Leaves Windows-generated events and every unavailable endpoint counter explicitly unavailable instead of estimating loss or converting missing evidence to zero.
- Passed 3 focused UC-33 tests and the full Dashboard API suite with 65 tests passed and 3 optional integration skips.
- Passed a live local ClickHouse flow: seven source rows were consolidated to six unique endpoints, all six were classified as interrupted from stale evidence, no endpoint exposed versioned loss counters, and the measured ratio remained unavailable rather than fabricated.
- Passed desktop and 390px mobile browser QA with working risk filtering, no page-level horizontal overflow or console errors, and a contained horizontally scrollable priority table on mobile.

## UC-34 verified behavior

- Adds persistent Admin-managed thresholds for measured loss ratio, durable-spool backlog, upload disconnection, and collection interruption, with explicit policy version, updater, and update timestamp.
- Loads a safe default policy when no file exists, validates every update before changing state, and persists accepted policies with a temporary file plus atomic rename.
- Applies the saved policy by default to operational loss alerts, interruption history, and host detail while retaining explicit query parameters as temporary User/analyst overrides.
- Emits `HE-BACKLOG-001` only when HostEyeShipper reports measured pending-event counters above the configured threshold; endpoints without versioned counters do not receive fabricated backlog or loss alerts.
- Provides responsive Admin save/reload controls in Fleet Log Loss and synchronizes the User Log Loss threshold inputs after an Admin policy update.
- Passed 3 focused UC-34 tests covering persistence/restart reload, validation without state mutation, alert behavior, and responsive UI structure.
- Passed the full Dashboard API suite with 68 tests passed, 3 optional integration skips, and 0 failures; JavaScript syntax checks and `git diff --check` also passed.
- Passed a live API and browser flow: policy version 3 saved with 3.5% loss, 40 pending events, 45-minute disconnection, and 90-minute interruption thresholds; six existing `HE-COLL-001` alerts remained evidence-backed, with no fabricated loss/backlog alerts where versioned endpoint counters were unavailable.
- Passed desktop and 390px mobile browser QA with successful policy save/reload, synchronized User thresholds, no page overflow, and no console errors.
