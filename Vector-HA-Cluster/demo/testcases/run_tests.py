import os
import sys
import time
import urllib.request

CLICKHOUSE_URL = os.getenv("CLICKHOUSE_URL", "http://clickhouse:8123")
EXPECTED_ENDPOINTS = int(os.getenv("EXPECTED_ENDPOINTS", "5"))
MIN_TOTAL_EVENTS = int(os.getenv("MIN_TOTAL_EVENTS", "100"))
TIMEOUT_SECONDS = int(os.getenv("TIMEOUT_SECONDS", "180"))


def query(sql):
    req = urllib.request.Request(CLICKHOUSE_URL, data=sql.encode(), method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read().decode().strip()


def wait_clickhouse():
    deadline = time.time() + TIMEOUT_SECONDS
    while time.time() < deadline:
        try:
            if query("SELECT 1") == "1":
                return
        except Exception as ex:
            print(f"waiting clickhouse: {ex}", flush=True)
        time.sleep(3)
    raise RuntimeError("ClickHouse did not become ready")


def main():
    wait_clickhouse()
    deadline = time.time() + TIMEOUT_SECONDS
    last = None
    while time.time() < deadline:
        try:
            total = int(query("SELECT count() FROM default.windows_system_logs WHERE agent_id LIKE 'hosteye-agent-hosteye-endpoint-sim-%'"))
            agents = int(query("SELECT uniqExact(agent_id) FROM default.windows_system_logs WHERE agent_id LIKE 'hosteye-agent-hosteye-endpoint-sim-%'"))
            security = int(query("SELECT count() FROM default.security_overview_events WHERE agent_id LIKE 'hosteye-agent-hosteye-endpoint-sim-%'"))
            process = int(query("SELECT count() FROM default.process_events WHERE agent_id LIKE 'hosteye-agent-hosteye-endpoint-sim-%'"))
            network = int(query("SELECT count() FROM default.network_events WHERE agent_id LIKE 'hosteye-agent-hosteye-endpoint-sim-%'"))
            dns = int(query("SELECT count() FROM default.dns_events WHERE agent_id LIKE 'hosteye-agent-hosteye-endpoint-sim-%'"))
            last = (total, agents, security, process, network, dns)
            print(f"demo-test total={total} agents={agents}/{EXPECTED_ENDPOINTS} security={security} process={process} network={network} dns={dns}", flush=True)
            if total >= MIN_TOTAL_EVENTS and agents >= EXPECTED_ENDPOINTS and security > 0 and process > 0 and network > 0 and dns > 0:
                print("PASS: HostEye demo pipeline accepted simulator events and populated ClickHouse/views", flush=True)
                return 0
        except Exception as ex:
            print(f"waiting pipeline data: {ex}", flush=True)
        time.sleep(5)
    print(f"FAIL: demo pipeline did not meet criteria. last={last}", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
