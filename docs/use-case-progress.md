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
