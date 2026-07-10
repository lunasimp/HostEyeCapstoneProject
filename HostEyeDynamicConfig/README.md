# HostEye Dynamic Config - Phase 5

Phase 5 bien Dynamic Config thanh co che endpoint apply that co verify trust bang Ed25519, RBAC admin, audit log, va agent identity proof:

- Admin khai bao policy theo `default`, `group`, hoac `agent`.
- Endpoint Rust client poll config theo `agent_id`, `host_id`, `group_id`.
- Server tra ve signed config envelope bang Ed25519 theo `key_id` production-style; HMAC-SHA256 chi con la fallback demo.
- Client verify chu ky, validate noi dung policy, stage file moi, apply atomic, va ACK trang thai that ve server.
- Neu validate/apply fail, client rollback ve file truoc do va ACK `apply_failed`.
- Che do `render`/`dry_run` dung de preview config ma khong chay post-validate.

## Chay server bang Docker

```powershell
cd C:\Users\ultim\Documents\Codex\2026-06-11\new-chat\github-clones\F-smooth-criminal-guard\HostEyeDynamicConfig
docker compose up --build -d
```

Health:

```powershell
Invoke-RestMethod http://localhost:5063/healthz
```

List policies:

```powershell
Invoke-RestMethod http://localhost:5063/api/v1/dynamic-config/policies
```

List agent va ACK moi nhat:

```powershell
Invoke-RestMethod `
  -Headers @{"x-hosteye-admin-token"="hosteye-admin-demo"} `
  http://localhost:5063/api/v1/dynamic-config/agents
```

## Chay client apply mot lan

Neu may co Rust local:

```powershell
$env:HOSTEYE_CONFIG_SERVER_URL="http://localhost:5063"
$env:HOSTEYE_AGENT_ID="agent-lab-001"
$env:HOSTEYE_HOST_ID="host-lab-001"
$env:HOSTEYE_GROUP_ID="group-lab"
$env:HOSTEYE_CONFIG_OUTPUT_DIR="C:\tmp\hosteye-dynamic-config-agent-lab-001"
$env:HOSTEYE_CONFIG_ONCE="true"
cargo run --bin hosteye-config-client
```

Neu dung Docker image da build:

```powershell
$dir = "C:\tmp\hosteye-phase3-agent"
New-Item -ItemType Directory -Force $dir | Out-Null

docker run --rm `
  -v "$dir`:/out" `
  -e HOSTEYE_CONFIG_SERVER_URL=http://host.docker.internal:5063 `
  -e HOSTEYE_AGENT_ID=agent-lab-001 `
  -e HOSTEYE_HOST_ID=host-lab-001 `
  -e HOSTEYE_GROUP_ID=group-lab `
  -e HOSTEYE_CONFIG_OUTPUT_DIR=/out `
  -e HOSTEYE_CONFIG_ONCE=true `
  hosteyedynamicconfig-hosteye-dynamic-config `
  hosteye-config-client
```

File client tao/cap nhat:

- `applied-policy.json`: signed envelope da apply.
- `vector-dynamic.toml`: cau hinh Vector render tu policy.
- `state.json`: policy/version cuoi da xu ly.
- `staging\...`: file moi truoc khi apply.
- `backups\...`: ban sao file cu de rollback.

## Bien moi truong Phase 3

| Bien | Mac dinh | Y nghia |
| --- | --- | --- |
| `HOSTEYE_CONFIG_SERVER_URL` | `http://127.0.0.1:5063` | Dynamic Config server. |
| `HOSTEYE_DYNAMIC_CONFIG_SIGNING_KEY` | demo key | HMAC fallback khi server dung `hmac-sha256`. |
| `HOSTEYE_AGENT_ID` | `agent-lab-001` | Dinh danh agent. |
| `HOSTEYE_HOST_ID` | `host-lab-001` | Dinh danh host. |
| `HOSTEYE_GROUP_ID` | `default` | Nhom/cum may de ap policy. |
| `HOSTEYE_CONFIG_OUTPUT_DIR` | `./hosteye-config-output` | Thu muc output local. |
| `HOSTEYE_APPLIED_POLICY_PATH` | `{output_dir}/applied-policy.json` | Duong dan policy file dich. |
| `HOSTEYE_VECTOR_DYNAMIC_PATH` | `{output_dir}/vector-dynamic.toml` | Duong dan Vector dynamic config dich. |
| `HOSTEYE_CONFIG_BACKUP_DIR` | `{output_dir}/backups` | Thu muc backup rollback. |
| `HOSTEYE_CONFIG_APPLY_MODE` | `apply` | `apply` hoac `render`/`render_only`/`dry_run`. |
| `HOSTEYE_CONFIG_PRE_VALIDATE_CMDS` | rong | Lenh validate truoc khi apply, ngan cach bang `;;`. |
| `HOSTEYE_CONFIG_POST_VALIDATE_CMDS` | rong | Lenh validate sau khi apply, dung de test Vector/Shipper. |
| `HOSTEYE_CONFIG_POLL_INTERVAL_SECONDS` | `60` | Chu ky poll khi chay service nen. |
| `HOSTEYE_CONFIG_ONCE` | `false` | `true` de chay mot lan cho CI/smoke test. |

Placeholder trong validate command:

- `{policy}`: duong dan policy file.
- `{vector_dynamic}`: duong dan `vector-dynamic.toml`.
- `{output_dir}`: thu muc output.

Vi du validate Vector that tren endpoint Windows:

```powershell
$env:HOSTEYE_CONFIG_POST_VALIDATE_CMDS='"C:\Program Files\Vector\vector.exe" validate --no-environment "{vector_dynamic}"'
```

## Smoke test Phase 3

Apply thanh cong:

```powershell
$dir = "C:\tmp\hosteye-phase3-apply"
New-Item -ItemType Directory -Force $dir | Out-Null

docker run --rm `
  -v "$dir`:/out" `
  -e HOSTEYE_CONFIG_SERVER_URL=http://host.docker.internal:5063 `
  -e HOSTEYE_AGENT_ID=agent-phase3-apply `
  -e HOSTEYE_HOST_ID=host-phase3-apply `
  -e HOSTEYE_GROUP_ID=group-lab `
  -e HOSTEYE_CONFIG_OUTPUT_DIR=/out `
  -e HOSTEYE_CONFIG_ONCE=true `
  hosteyedynamicconfig-hosteye-dynamic-config hosteye-config-client
```

Render-only:

```powershell
docker run --rm `
  -v "C:\tmp\hosteye-phase3-render:/out" `
  -e HOSTEYE_CONFIG_SERVER_URL=http://host.docker.internal:5063 `
  -e HOSTEYE_AGENT_ID=agent-phase3-render `
  -e HOSTEYE_HOST_ID=host-phase3-render `
  -e HOSTEYE_GROUP_ID=group-lab `
  -e HOSTEYE_CONFIG_OUTPUT_DIR=/out `
  -e HOSTEYE_CONFIG_ONCE=true `
  -e HOSTEYE_CONFIG_APPLY_MODE=render `
  hosteyedynamicconfig-hosteye-dynamic-config hosteye-config-client
```

Rollback khi post-validate fail:

```powershell
$dir = "C:\tmp\hosteye-phase3-rollback"
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Content -LiteralPath (Join-Path $dir 'applied-policy.json') -Value '{"old":true}'
Set-Content -LiteralPath (Join-Path $dir 'vector-dynamic.toml') -Value '# old vector dynamic'

docker run --rm `
  -v "$dir`:/out" `
  -e HOSTEYE_CONFIG_SERVER_URL=http://host.docker.internal:5063 `
  -e HOSTEYE_AGENT_ID=agent-phase3-rollback `
  -e HOSTEYE_HOST_ID=host-phase3-rollback `
  -e HOSTEYE_GROUP_ID=group-lab `
  -e HOSTEYE_CONFIG_OUTPUT_DIR=/out `
  -e HOSTEYE_CONFIG_ONCE=true `
  -e HOSTEYE_CONFIG_POST_VALIDATE_CMDS="exit 9" `
  hosteyedynamicconfig-hosteye-dynamic-config hosteye-config-client
```

Ky vong:

- Apply thanh cong ACK `applied`.
- Render-only ACK `rendered`.
- Validate fail ACK `apply_failed`, file cu duoc restore tu `backups`.
- Khi `HOSTEYE_CONFIG_ONCE=true`, apply fail tra exit code khac 0 de CI bat loi.


## Phase 4 - Ed25519 policy signing

Phase 4 bo sung lop trust cho dynamic config:

- Server ky envelope bang Ed25519 mac dinh.
- Envelope co `signature_algorithm`, `key_id`, `config_sha256`, va `signature`.
- Client verify `config_sha256` truoc, sau do verify Ed25519 signature bang public-key keyring.
- Neu `key_id` khong nam trong keyring tin cay, client tu choi apply va one-shot mode tra non-zero.
- HMAC-SHA256 van duoc giu lai de test backward-compatible bang `HOSTEYE_DYNAMIC_CONFIG_SIGNATURE_ALGORITHM=hmac-sha256`.

Server env:

| Bien | Mac dinh | Y nghia |
| --- | --- | --- |
| `HOSTEYE_DYNAMIC_CONFIG_SIGNATURE_ALGORITHM` | `ed25519` | Thuat toan ky envelope: `ed25519` hoac `hmac-sha256`. |
| `HOSTEYE_DYNAMIC_CONFIG_ED25519_KEY_ID` | `hosteye-demo-ed25519-v1` | Key id de client chon public key verify. |
| `HOSTEYE_DYNAMIC_CONFIG_ED25519_PRIVATE_KEY_SEED_HEX` | derived demo seed | 32-byte Ed25519 private seed hex. Production phai inject secret rieng. |
| `HOSTEYE_DYNAMIC_CONFIG_SIGNING_KEY` | demo key | HMAC fallback va demo seed source neu chua co private seed. |

Client env:

| Bien | Mac dinh | Y nghia |
| --- | --- | --- |
| `HOSTEYE_DYNAMIC_CONFIG_ED25519_PUBLIC_KEYS` | demo public key | Danh sach key tin cay dang `key_id:hex_public_key,key_id2:hex_public_key2`. |
| `HOSTEYE_DYNAMIC_CONFIG_SIGNING_KEY` | demo key | HMAC fallback khi server tra envelope `hmac-sha256`. |

Production key rotation du kien:

1. Them public key moi vao client keyring trong khi server van ky bang key cu.
2. Doi server sang `HOSTEYE_DYNAMIC_CONFIG_ED25519_KEY_ID` moi va private seed moi.
3. Theo doi ACK `applied/rendered/apply_failed` tren dashboard.
4. Sau khi fleet on dinh, go public key cu khoi keyring.

Smoke test Ed25519:

```powershell
$dir = "C:\tmp\hosteye-phase4-ed25519"
New-Item -ItemType Directory -Force $dir | Out-Null

docker run --rm `
  -v "$dir`:/out" `
  -e HOSTEYE_CONFIG_SERVER_URL=http://host.docker.internal:5063 `
  -e HOSTEYE_AGENT_ID=agent-phase4-ed25519 `
  -e HOSTEYE_HOST_ID=host-phase4-ed25519 `
  -e HOSTEYE_GROUP_ID=group-lab `
  -e HOSTEYE_CONFIG_OUTPUT_DIR=/out `
  -e HOSTEYE_CONFIG_ONCE=true `
  hosteyedynamicconfig-hosteye-dynamic-config hosteye-config-client
```

Negative test voi keyring sai:

```powershell
docker run --rm `
  -v "C:\tmp\hosteye-phase4-badkey:/out" `
  -e HOSTEYE_CONFIG_SERVER_URL=http://host.docker.internal:5063 `
  -e HOSTEYE_AGENT_ID=agent-phase4-badkey `
  -e HOSTEYE_HOST_ID=host-phase4-badkey `
  -e HOSTEYE_GROUP_ID=group-lab `
  -e HOSTEYE_CONFIG_OUTPUT_DIR=/out `
  -e HOSTEYE_CONFIG_ONCE=true `
  -e HOSTEYE_DYNAMIC_CONFIG_ED25519_PUBLIC_KEYS="wrong-key:0000000000000000000000000000000000000000000000000000000000000000" `
  hosteyedynamicconfig-hosteye-dynamic-config hosteye-config-client
```

Ky vong negative test fail voi loi `unknown ed25519 key_id` va khong apply file moi.


## Phase 5 - RBAC, audit log, agent identity proof

Phase 5 bo sung cac lop control-plane production:

- Admin API dung token co scope thay vi mot token all-power mac dinh.
- Demo co token full `hosteye-admin-demo` va token readonly `hosteye-readonly`.
- `GET /policies` can `policy:read`.
- `POST /policies` can `policy:write` va sinh audit event.
- `GET /agents` can `agent:read`.
- `GET /audit` can `audit:read`.
- Endpoint client config/ACK bat buoc gui identity proof neu `HOSTEYE_DYNAMIC_CONFIG_REQUIRE_AGENT_IDENTITY=true`.
- Identity proof hien la HMAC header de test trong lab; production co the thay bang mTLS/connector proxy ma khong doi contract agent_id/host_id/group_id.

Server env Phase 5:

| Bien | Mac dinh | Y nghia |
| --- | --- | --- |
| `HOSTEYE_DYNAMIC_CONFIG_ADMIN_TOKENS` | `hosteye-admin-demo=policy:read,policy:write,agent:read,audit:read;hosteye-readonly=policy:read` | Danh sach token va scope, ngan cach nhieu token bang `;`. |
| `HOSTEYE_DYNAMIC_CONFIG_REQUIRE_AGENT_IDENTITY` | `true` | Bat/tat verify identity proof cho endpoint client. |
| `HOSTEYE_DYNAMIC_CONFIG_AGENT_IDENTITY_SECRET` | demo secret | Secret tao HMAC proof trong lab. Production nen thay bang per-device credential/mTLS. |

Agent headers khi poll config/ACK:

```text
x-hosteye-agent-id: <agent_id>
x-hosteye-host-id: <host_id>
x-hosteye-group-id: <group_id>
x-hosteye-agent-proof: hmac_sha256(secret, "HOSTEYE_AGENT_IDENTITY_V1\nagent_id\nhost_id\ngroup_id")
```

RBAC smoke test:

```powershell
# Khong token: ky vong 401
Invoke-RestMethod http://localhost:5063/api/v1/dynamic-config/policies

# Token dung scope: ky vong tra ve policies
Invoke-RestMethod `
  -Headers @{"x-hosteye-admin-token"="hosteye-admin-demo"} `
  http://localhost:5063/api/v1/dynamic-config/policies
```

Agent identity negative test:

```powershell
# Thieu identity headers: ky vong 401
Invoke-RestMethod "http://localhost:5063/api/v1/dynamic-config/agents/agent-x/config?host_id=host-x&group_id=group-lab&agent_version=0.1.0&current_policy_id=&current_version=0"
```

Audit API:

```powershell
Invoke-RestMethod `
  -Headers @{"x-hosteye-admin-token"="hosteye-admin-demo"} `
  http://localhost:5063/api/v1/dynamic-config/audit
```

Dashboard API proxy:

```powershell
Invoke-RestMethod http://localhost:5055/api/dashboard/dynamic-config/audit
```

## API chinh

Get config cho endpoint:

```text
GET /api/v1/dynamic-config/agents/{agent_id}/config?host_id=...&group_id=...&agent_version=...
```

ACK:

```text
POST /api/v1/dynamic-config/agents/{agent_id}/ack
```

Admin list agent:

```powershell
Invoke-RestMethod `
  -Headers @{"x-hosteye-admin-token"="hosteye-admin-demo"} `
  http://localhost:5063/api/v1/dynamic-config/agents
```

## Phase tiep theo

- Phase 6: thay HMAC identity proof bang mTLS/per-device non-exportable key trong HostEye Connector.
- Phase 7: tich hop HostEyeShipper Rust da nen tang va config directive runtime.




