# HostEye Use Case Progress

This tracker records implementation-level verification. Report 5 is reserved for system and end-to-end flow testing.

| Use case | Status | Verification | Branch / commit |
|---|---|---|---|
| UC-01 - Dashboard overview | Implemented | 6 integration tests passed | `uc/UC-01-dashboard-overview` / `fa95e70` |
| UC-02 - Monitor log collection status | Implemented | 6 UC-02 integration tests passed; full dashboard API suite 12/12 passed | `uc/UC-02-collection-status` |
| UC-03 - Search and filter logs | Implemented | 6 automated tests passed; 1 real ClickHouse Docker integration test passed; full default suite 18 passed / 1 integration skip; desktop/mobile browser QA passed | `uc/UC-03-log-search` |
| UC-06 - View alerts | Implemented | 5 mock/API tests passed; real ClickHouse Docker integration 6/6 passed; full default suite 23 passed / 2 optional integration skips; desktop/mobile browser QA passed | `uc/UC-06-alert-list` |
| UC-07 - View alert details | Implemented | 9 alert API/UI tests passed; full default suite 27 passed / 2 optional integration skips; real ClickHouse event and failed-logon detail flows passed; desktop/mobile browser QA passed | `uc/UC-07-alert-detail` |

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
