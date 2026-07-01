# HostEye Client EXE Runbook

Tai lieu nhanh cho may client cai `HostEye_Endpoint_Installer.exe` va gui logs ve domain demo.

## 1. Dia chi he thong

Dashboard:

```text
https://hosteye.iahn.hanoi.vn/dashboard/
```

Telemetry endpoint agent gui logs:

```text
https://hosteye.iahn.hanoi.vn/api/v1/telemetry
```

Dashboard API:

```text
https://hosteye.iahn.hanoi.vn/api/
```

ClickHouse HTTP query:

```text
https://hosteye.iahn.hanoi.vn/clickhouse/
```

## 2. Cai file EXE tren client

Chay file nay bang quyen Administrator:

```text
HostEye_Endpoint_Installer.exe
```

Sau khi cai, installer se:

- Copy agent vao `C:\Program Files\HostEye`
- Tao du lieu runtime tai `C:\ProgramData\HostEye`
- Cai service `HostEyeAgent`
- Tao scheduled task `HostEye_Shipper_Startup`
- Cai Sysmon neu co binary di kem
- Ghi log tai `C:\ProgramData\HostEye\logs`

Kiem tra client da chay:

```powershell
Get-Service HostEyeAgent
Get-ScheduledTask -TaskName HostEye_Shipper_Startup
Get-Process vector,HostEyeShipper -ErrorAction SilentlyContinue
```

Xem log shipper tren client:

```powershell
Get-Content "C:\ProgramData\HostEye\logs\shipper.log" -Tail 80
```

## 3. Truy van logs gan nhat

20 logs moi nhat:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20kafka_timestamp%2Ccomputer%2Cevent_id%2Cprovider_name%2Cchannel%2Cmessage%20FROM%20default.windows_system_logs%20ORDER%20BY%20kafka_timestamp%20DESC%20LIMIT%2020"
```

50 logs moi nhat:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20kafka_timestamp%2Ccomputer%2Cevent_id%2Cprovider_name%2Cchannel%2Cprocess_path%2Ctarget_image%2Ctarget_object%2Cmessage%20FROM%20default.windows_system_logs%20ORDER%20BY%20kafka_timestamp%20DESC%20LIMIT%2050"
```

Logs trong 10 phut gan nhat:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20kafka_timestamp%2Ccomputer%2Cevent_id%2Cprovider_name%2Cmessage%20FROM%20default.windows_system_logs%20WHERE%20kafka_timestamp%20%3E%3D%20now()%20-%20INTERVAL%2010%20MINUTE%20ORDER%20BY%20kafka_timestamp%20DESC%20LIMIT%2050"
```

Dem tong logs trong 10 phut gan nhat:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20count()%20FROM%20default.windows_system_logs%20WHERE%20kafka_timestamp%20%3E%3D%20now()%20-%20INTERVAL%2010%20MINUTE"
```

Loc theo ten may client:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20kafka_timestamp%2Ccomputer%2Cevent_id%2Cmessage%20FROM%20default.windows_system_logs%20WHERE%20computer%20%3D%20'CLIENT-PC-NAME'%20ORDER%20BY%20kafka_timestamp%20DESC%20LIMIT%2050"
```

## 4. Truy van jitter

Qua Dashboard API:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/api/dashboard/jitter/summary"
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/api/dashboard/jitter/hosts"
```

Query truc tiep ClickHouse:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20kafka_timestamp%2Ccomputer%2Cplanned_jitter_ms%2Cjitter_window_ms%2Cbatch_size%2Cstatus_code%2Csuccess%2Csend_duration_ms%20FROM%20default.shipper_runtime_metrics%20ORDER%20BY%20kafka_timestamp%20DESC%20LIMIT%2050"
```

Tong hop jitter theo host:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20computer%2Ccount()%20AS%20samples%2Cavg(planned_jitter_ms)%20AS%20avg_jitter_ms%2Cquantile(0.95)(planned_jitter_ms)%20AS%20p95_jitter_ms%2Cmax(planned_jitter_ms)%20AS%20max_jitter_ms%2Cmax(kafka_timestamp)%20AS%20last_seen%20FROM%20default.shipper_runtime_metrics%20GROUP%20BY%20computer%20ORDER%20BY%20p95_jitter_ms%20DESC%20LIMIT%2020"
```

## 5. Kiem tra spool tren client

Thu muc spool:

```text
C:\ProgramData\HostEye\spool
```

Xem file spool dang co:

```powershell
Get-ChildItem "C:\ProgramData\HostEye\spool" -Force
```

Dem so file spool:

```powershell
(Get-ChildItem "C:\ProgramData\HostEye\spool" -File -ErrorAction SilentlyContinue).Count
```

Tinh tong dung luong spool:

```powershell
(Get-ChildItem "C:\ProgramData\HostEye\spool" -File -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
```

Xem state shipper:

```powershell
Get-ChildItem "C:\ProgramData\HostEye\shipper_state" -Force
```

Xem shipper co gui thanh cong khong:

```powershell
Select-String -Path "C:\ProgramData\HostEye\logs\shipper.log" -Pattern "Sent OK|Applying deterministic send jitter|HTTP|error|failed" -CaseSensitive:$false | Select-Object -Last 80
```

## 6. Cac truong log chinh gui len server

Bang raw logs: `default.windows_system_logs`

Nhom dinh danh/thoi gian:

```text
kafka_timestamp, timestamp, agent_id, host_id, os, source_platform, computer,
channel, event_id, record_id, provider_name, level, idempotency_key
```

Noi dung raw va message:

```text
raw_log, event_data_json, message, source_type, path, method
```

User/rule:

```text
user_name, user_id, rule_name
```

Process:

```text
process_guid, parent_process_guid, target_process_guid,
process_id, parent_process_id, target_process_id,
process_path, parent_process_path, target_image,
current_directory, command_line, parent_command_line,
hashes, imphash
```

Network/DNS:

```text
source_ip, source_port, destination_ip, destination_port,
protocol, initiated, dns_query, query_status
```

File/Registry/Process access:

```text
target_filename, target_object, granted_access, call_trace
```

Bang jitter/spool metrics: `default.shipper_runtime_metrics`

```text
kafka_timestamp, metric_timestamp, agent_id, host_id, computer, source_platform,
shipper_version, metric_type, gateway_uri, spool_directory, spool_file,
line_offset, next_line_offset, batch_size, batch_bytes, compressed_bytes,
planned_jitter_ms, jitter_window_ms, retry_attempt, planned_backoff_ms,
spool_depth_bytes, spool_file_count, pending_file_count,
max_spool_bytes, low_watermark_bytes, status_code, send_duration_ms,
success, data_loss, message, idempotency_key
```

## 7. Dung thu thap logs tren client

Chay PowerShell bang quyen Administrator.

Dung bang script demo:

```powershell
& "C:\Program Files\HostEye\Pause-HostEyeDemoCollection.ps1"
```

Kiem tra da dung:

```powershell
Get-Service HostEyeAgent
Get-Process vector,HostEyeShipper -ErrorAction SilentlyContinue
Get-ScheduledTask -TaskName HostEye_Shipper_Startup
```

Dung cuong buc:

```powershell
Stop-Service HostEyeAgent -Force
Stop-ScheduledTask -TaskName HostEye_Shipper_Startup
Stop-Process -Name vector,HostEyeShipper -Force -ErrorAction SilentlyContinue
```

Bat lai thu thap:

```powershell
& "C:\Program Files\HostEye\Resume-HostEyeDemoCollection.ps1"
```

Hoac bat thu cong:

```powershell
Start-Service HostEyeAgent
Start-ScheduledTask -TaskName HostEye_Shipper_Startup
```

## 8. Test nhanh mot event da ve server chua

Sau khi cai client 1-3 phut, chay:

```powershell
Invoke-WebRequest -UseBasicParsing "https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20computer%2Ccount()%20AS%20events%2Cmax(kafka_timestamp)%20AS%20last_seen%20FROM%20default.windows_system_logs%20GROUP%20BY%20computer%20ORDER%20BY%20last_seen%20DESC%20LIMIT%2010"
```

Neu thay ten may client va `last_seen` moi, logs da ve server.
