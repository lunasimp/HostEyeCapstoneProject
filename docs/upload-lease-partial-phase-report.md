# Upload Lease Enforcement - Partial Phase Report

## Mục tiêu giai đoạn

Giai đoạn này xử lý phần còn thiếu của cơ chế permission-based upload / upload lease. Trước khi sửa, hệ thống đã có endpoint admission nhưng mới ở mức "xin phép rồi log", chưa thật sự ràng buộc việc upload chunk.

Yêu cầu cần hoàn thiện:

- Server cấp `lease_id`.
- Server trả `max_batch_mb`.
- Server trả `max_upload_rate_kbps`.
- Server trả `lease_ttl_seconds`.
- Shipper phải enforce batch size, upload rate, TTL.
- Shipper phải gửi `lease_id` kèm telemetry chunk.
- Server phải verify lease khi nhận chunk.

## Trạng thái trước khi sửa

Server đã có endpoint:

```text
POST /api/v1/admission/request
```

Server có trả:

```json
{
  "admission": "ok",
  "lease_id": "...",
  "lease_ttl_seconds": 30,
  "max_batch_mb": 5,
  "retry_after_seconds": 0
}
```

Nhưng còn thiếu:

- Chưa có `max_upload_rate_kbps`.
- Shipper chỉ log `lease_id`, không dùng để kiểm soát upload.
- Chunk gửi lên `/api/v1/telemetry` không có `lease_id`.
- Gateway không kiểm chunk có lease hợp lệ hay không.
- Lease chưa có trạng thái `used`, nên chưa chặn reuse.
- ClickHouse chưa lưu đủ metadata lease.

Đánh giá trước sửa: partial, khoảng 40-50%.

## Thay đổi đã triển khai

### 1. Server cấp lease đầy đủ hơn

File:

```text
VectorIngestAckGateway/server.js
```

Thêm biến môi trường:

```text
ADMISSION_MAX_UPLOAD_RATE_KBPS
REQUIRE_UPLOAD_LEASE
```

Response admission hiện có:

```json
{
  "admission": "ok",
  "lease_id": "...",
  "lease_ttl_seconds": 30,
  "lease_expires_at": "...",
  "max_batch_mb": 5,
  "max_upload_rate_kbps": 1024,
  "retry_after_seconds": 0,
  "message": "upload lease granted"
}
```

Server lưu lease trong memory với:

```text
agentId
hostId
computer
issuedAt
expiresAt
expiresAtIso
maxBatchMb
maxUploadRateKbps
used
```

### 2. Server verify lease khi nhận chunk

File:

```text
VectorIngestAckGateway/server.js
```

Trước khi lưu raw chunk và forward sang Vector, gateway kiểm:

- Có `lease_id` không.
- Lease có tồn tại không.
- Lease còn hạn không.
- Lease đã dùng chưa.
- Lease có đúng `agent_id`, `host_id`, `computer` không.
- Batch có vượt `max_batch_mb` không.

Các lỗi chính:

```text
428 lease_required
409 lease_invalid
409 lease_expired
409 lease_used
403 lease_agent_mismatch
403 lease_host_mismatch
403 lease_computer_mismatch
413 lease_batch_too_large
```

Duplicate chunk đã accepted vẫn được ACK duplicate trước khi kiểm lease. Điều này giữ an toàn cho trường hợp server đã nhận/lưu chunk nhưng client bị mất ACK rồi retry.

### 3. Shipper enforce lease

File:

```text
VectorBuild/SOCShipper/Program.cs
```

Shipper hiện:

1. Đọc batch từ spool.
2. Chờ jitter.
3. Xin upload lease.
4. Kiểm `lease_id`, TTL, `max_batch_mb`.
5. Gắn lease metadata vào chunk payload.
6. Upload gzip với rate limit theo `max_upload_rate_kbps`.
7. Verify ACK trả đúng `lease_id`.

Chunk payload mới có thêm:

```json
{
  "batch_bytes": 1234,
  "lease_id": "...",
  "lease_issued_at": "...",
  "lease_expires_at": "...",
  "lease_ttl_seconds": 30,
  "max_batch_mb": 5,
  "max_upload_rate_kbps": 1024
}
```

Shipper config thêm:

```json
{
  "EnableAdmissionControl": true,
  "RequireUploadLease": true
}
```

### 4. Upload rate limiting

File:

```text
VectorBuild/SOCShipper/Program.cs
```

`GzipContent` đã được sửa để có thể stream dữ liệu theo tốc độ tối đa:

```text
max_upload_rate_kbps
```

Cách làm hiện tại:

- Payload vẫn được gzip trước.
- Khi ghi lên network stream, shipper chia buffer nhỏ.
- Sau mỗi phần đã gửi, shipper delay để tốc độ trung bình không vượt rate được cấp.

Đây là enforcement ở client side. Server hiện ghi nhận rate trong metadata nhưng chưa đo lại tốc độ TCP thực tế.

### 5. Schema lưu trữ

File mới:

```text
Vector-HA-Cluster/clickhouse-init/007_upload_lease_enforcement.sql
```

Thêm cột vào `admission_decisions`:

```text
max_batch_mb
max_upload_rate_kbps
lease_expires_at
```

Thêm cột vào `ingest_chunks`:

```text
lease_id
lease_expires_at
max_batch_mb
max_upload_rate_kbps
```

Thêm cột vào `raw_chunk_vault`:

```text
lease_id
lease_expires_at
max_batch_mb
max_upload_rate_kbps
```

Thêm cột vào `shipper_runtime_metrics`:

```text
lease_id
lease_issued_at
lease_expires_at
lease_ttl_seconds
max_batch_mb
max_upload_rate_kbps
```

### 6. Docker / Gateway config

File:

```text
Vector-HA-Cluster/docker-compose.yml
```

Thêm env:

```text
ADMISSION_MAX_UPLOAD_RATE_KBPS=1024
REQUIRE_UPLOAD_LEASE=true
```

### 7. Dashboard API

File:

```text
VectorDashboardApi/src/server.js
```

Chunk API giờ trả thêm:

```text
leaseId
leaseExpiresAt
leaseTtlSeconds
maxBatchMb
maxUploadRateKbps
```

Các trường này giúp UI/debug thấy chunk nào đã gửi dưới lease nào.

## Luồng mới sau khi sửa

```text
HostEyeShipper
  -> đọc spool batch
  -> chờ jitter
  -> POST /api/v1/admission/request
  <- lease_id + ttl + max_batch_mb + max_upload_rate_kbps
  -> kiểm lease local
  -> gzip chunk
  -> upload theo rate limit
  -> POST /api/v1/telemetry kèm lease_id

Nginx
  -> mTLS + allowlist
  -> proxy vào ACK gateway

ACK Gateway
  -> validate schema/checksum
  -> duplicate check
  -> verify lease
  -> consume lease
  -> lưu raw chunk
  -> ghi ingest_chunks
  -> forward Vector
  -> ACK queued kèm lease_id

ClickHouse
  -> lưu admission_decisions
  -> lưu ingest_chunks
  -> lưu raw_chunk_vault
  -> lưu shipper_runtime_metrics
  -> lưu windows_system_logs
```

## Kết quả kiểm thử

### Test 1: Chunk không có lease

Gửi chunk trực tiếp không có `lease_id`.

Kết quả:

```json
{
  "ack": false,
  "commit": false,
  "status": "lease_required",
  "lease_id": "",
  "message": "upload lease_id is required"
}
```

HTTP status:

```text
428
```

### Test 2: Shipper xin lease và gửi thành công

Log shipper:

```text
Admission OK lease=66b4775c-ff33-427f-b9eb-70a1de2b2456 ttl=30s max_batch_mb=5.000 max_upload_rate_kbps=1024.
Sending chunk=... lease=66b4775c-ff33-427f-b9eb-70a1de2b2456 rate_kbps=1024
Sent OK ... ack_status=queued
```

ClickHouse `admission_decisions`:

```text
decision=ok
lease_id=66b4775c-ff33-427f-b9eb-70a1de2b2456
lease_ttl_seconds=30
max_batch_mb=5
max_upload_rate_kbps=1024
```

ClickHouse `ingest_chunks`:

```text
status=queued
lease_id=66b4775c-ff33-427f-b9eb-70a1de2b2456
max_batch_mb=5
max_upload_rate_kbps=1024
```

ClickHouse `shipper_runtime_metrics`:

```text
success=1
status_code=200
lease_id=66b4775c-ff33-427f-b9eb-70a1de2b2456
lease_ttl_seconds=30
max_upload_rate_kbps=1024
```

### Test 3: Reuse lease cho chunk khác

Kết quả:

```json
{
  "ack": false,
  "commit": false,
  "status": "lease_used",
  "message": "upload lease was already used"
}
```

HTTP status:

```text
409
```

## Trạng thái sau khi sửa

Đã hoàn thiện từ partial lên mức enforced MVP:

- Có lease_id thật.
- Có TTL thật.
- Có max batch thật.
- Có max upload rate.
- Client enforce batch, TTL, upload rate.
- Client gửi lease_id trong chunk.
- Server verify và consume lease.
- Server chặn missing/expired/reused/mismatched lease.
- ClickHouse lưu đủ metadata để audit.

Đánh giá sau sửa: khoảng 75-85%.

## Giới hạn còn lại

Các điểm vẫn chưa phải enterprise-grade hoàn toàn:

- Lease state đang lưu in-memory trong ACK gateway. Nếu gateway restart, lease đang cấp sẽ mất.
- Nếu chạy nhiều replica ACK gateway, lease cấp ở replica A có thể không tồn tại ở replica B nếu không sticky session hoặc shared store.
- Server chưa đo tốc độ upload TCP thực tế; hiện rate limit enforce chính ở client.
- Chưa có endpoint release lease/cancel lease.
- Chưa có per-company/per-group policy rank nâng cao.
- Chưa có shared lease backend như Redis/ClickHouse/Kafka compacted topic.

## Đề xuất bước tiếp theo

Để lên production hơn:

1. Chuyển lease state sang Redis hoặc ClickHouse table có TTL.
2. Thêm `lease_status` với `issued`, `consumed`, `expired`, `rejected`.
3. Nginx hoặc gateway đo body receive duration để audit tốc độ thực tế.
4. Thêm quota theo tenant/company/cert serial.
5. Dashboard thêm tab/section "Upload Leases" để theo dõi reject/reuse/expired.
