import datetime as dt
import gzip
import hashlib
import json
import os
import random
import socket
import time
import urllib.error
import urllib.request

ENDPOINT_ID = os.getenv("ENDPOINT_ID", "hosteye-endpoint-sim-01")
HOSTNAME = os.getenv("HOSTNAME_OVERRIDE", socket.gethostname()).upper()
GATEWAY_URL = os.getenv("GATEWAY_URL", "http://vector-gateway-1:8686")
DEMO_DURATION_SECONDS = int(os.getenv("DEMO_DURATION_SECONDS", "120"))
EVENTS_PER_BATCH = int(os.getenv("EVENTS_PER_BATCH", "50"))
SEND_INTERVAL_SECONDS = int(os.getenv("SEND_INTERVAL_SECONDS", "10"))
JITTER_WINDOW_SECONDS = int(os.getenv("JITTER_WINDOW_SECONDS", "60"))
BASE_BACKOFF_SECONDS = int(os.getenv("BASE_BACKOFF_SECONDS", "2"))
MAX_BACKOFF_SECONDS = int(os.getenv("MAX_BACKOFF_SECONDS", "60"))
LOOP_FOREVER = os.getenv("LOOP_FOREVER", "false").lower() == "true"

EVENT_TYPES = [1, 3, 10, 11, 12, 13, 22, 4624, 4672, 4688]


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stable_jitter(window, batch_no):
    if window <= 0:
        return 0
    seed = f"{ENDPOINT_ID}:{batch_no}".encode()
    return int(hashlib.sha256(seed).hexdigest(), 16) % window


def full_jitter_delay(attempt):
    cap = min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * (2 ** max(0, attempt - 1)))
    return random.uniform(0, cap)


def event_payload(record_id):
    event_id = EVENT_TYPES[record_id % len(EVENT_TYPES)]
    is_sysmon = event_id < 1000
    channel = "Microsoft-Windows-Sysmon/Operational" if is_sysmon else "Security"
    process_guid = "{" + hashlib.md5(f"{ENDPOINT_ID}:{record_id}".encode()).hexdigest() + "}"
    base = {
        "timestamp": now_iso(),
        "agent_id": f"hosteye-agent-{ENDPOINT_ID}",
        "host_id": f"hosteye-host-{ENDPOINT_ID}",
        "os": "Windows 11 demo container simulator",
        "source_platform": "hosteye-windows-endpoint-simulator",
        "computer": HOSTNAME,
        "channel": channel,
        "event_id": event_id,
        "record_id": record_id,
        "provider_name": "Microsoft-Windows-Sysmon" if is_sysmon else "Microsoft-Windows-Security-Auditing",
        "level": "Information",
        "source_type": "hosteye_demo_endpoint_simulator",
        "user_name": f"{HOSTNAME}\\demo.user",
        "user_id": "S-1-5-21-demo",
        "process_guid": process_guid,
        "process_id": 4000 + (record_id % 500),
        "parent_process_id": 1000 + (record_id % 100),
        "process_path": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "parent_process_path": "C:\\Windows\\explorer.exe",
        "command_line": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File demo_attack_chain.ps1 token=DEMO_SECRET",
        "parent_command_line": "explorer.exe",
        "raw_log": f"demo windows event {event_id} from {HOSTNAME} record {record_id}",
    }
    event_data = {
        "ProcessGuid": process_guid,
        "ProcessId": str(base["process_id"]),
        "Image": base["process_path"],
        "CommandLine": base["command_line"],
        "ParentImage": base["parent_process_path"],
        "ParentCommandLine": base["parent_command_line"],
        "User": base["user_name"],
    }
    if event_id == 3:
        base.update({"source_ip": "10.10.5.23", "source_port": 49152, "destination_ip": "203.0.113.10", "destination_port": 443, "protocol": "tcp", "initiated": "true"})
        event_data.update({"SourceIp": base["source_ip"], "SourcePort": str(base["source_port"]), "DestinationIp": base["destination_ip"], "DestinationPort": str(base["destination_port"]), "Protocol": "tcp", "Initiated": "true"})
    if event_id == 11:
        base["target_filename"] = "C:\\Users\\Public\\demo_payload.dll"
        event_data["TargetFilename"] = base["target_filename"]
    if event_id in (12, 13):
        base["target_object"] = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\DemoPersistence"
        event_data["TargetObject"] = base["target_object"]
    if event_id == 22:
        base["dns_query"] = "demo-c2.example.test"
        base["query_status"] = "0"
        event_data.update({"QueryName": base["dns_query"], "QueryStatus": base["query_status"]})
    if event_id == 10:
        base.update({"target_process_guid": process_guid, "target_process_id": 8888, "target_image": "C:\\Windows\\System32\\lsass.exe", "granted_access": "0x1010", "call_trace": "demo.dll+0x1000"})
        event_data.update({"TargetProcessGuid": base["target_process_guid"], "TargetProcessId": str(base["target_process_id"]), "TargetImage": base["target_image"], "GrantedAccess": base["granted_access"], "CallTrace": base["call_trace"]})
    base["event_data"] = event_data
    base["idempotency_key"] = hashlib.sha256(f"{base['computer']}:{base['channel']}:{record_id}".encode()).hexdigest()
    return base


def send_batch(batch):
    body = json.dumps(batch, separators=(",", ":")).encode()
    compressed = gzip.compress(body)
    req = urllib.request.Request(
        GATEWAY_URL,
        data=compressed,
        headers={"Content-Type": "application/json", "Content-Encoding": "gzip", "User-Agent": "HostEye-DemoEndpointSimulator/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, resp.read(200)


def main():
    print(f"endpoint={ENDPOINT_ID} host={HOSTNAME} gateway={GATEWAY_URL} duration={DEMO_DURATION_SECONDS}s jitter_window={JITTER_WINDOW_SECONDS}s", flush=True)
    deadline = time.time() + DEMO_DURATION_SECONDS
    batch_no = 0
    record_id = int(time.time()) % 1_000_000
    attempt = 0
    while LOOP_FOREVER or time.time() < deadline:
        jitter = stable_jitter(JITTER_WINDOW_SECONDS, batch_no)
        print(f"endpoint={ENDPOINT_ID} batch={batch_no} jitter={jitter}s", flush=True)
        time.sleep(jitter)
        batch = [event_payload(record_id + i) for i in range(EVENTS_PER_BATCH)]
        try:
            status, _ = send_batch(batch)
            print(f"endpoint={ENDPOINT_ID} sent batch={batch_no} events={len(batch)} status={status}", flush=True)
            attempt = 0
            record_id += EVENTS_PER_BATCH
            batch_no += 1
            time.sleep(SEND_INTERVAL_SECONDS)
        except urllib.error.HTTPError as ex:
            attempt += 1
            delay = full_jitter_delay(attempt)
            print(f"endpoint={ENDPOINT_ID} http_error={ex.code} attempt={attempt} backoff={delay:.1f}s", flush=True)
            time.sleep(delay)
        except Exception as ex:
            attempt += 1
            delay = full_jitter_delay(attempt)
            print(f"endpoint={ENDPOINT_ID} send_error={ex} attempt={attempt} backoff={delay:.1f}s", flush=True)
            time.sleep(delay)
    print(f"endpoint={ENDPOINT_ID} completed", flush=True)


if __name__ == "__main__":
    main()
