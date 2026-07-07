const crypto = require("crypto");

const baseUrl = process.env.HOSTEYE_LOCAL_INGEST_URL || "http://127.0.0.1:8088";
const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const agentId = process.env.HOSTEYE_DEMO_AGENT_ID || `local-demo-agent-${suffix}`;
const hostId = process.env.HOSTEYE_DEMO_HOST_ID || `local-demo-host-${suffix}`;
const computer = process.env.HOSTEYE_DEMO_COMPUTER || `LOCAL-DEMO-${suffix}`;
const now = new Date().toISOString();

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function main() {
  const events = [
    {
      agent_id: agentId,
      host_id: hostId,
      computer,
      timestamp: now,
      channel: "Microsoft-Windows-Sysmon/Operational",
      event_id: 1,
      record_id: 1001,
      provider_name: "Microsoft-Windows-Sysmon",
      level: "Information",
      message: "Local demo process create event from HostEye smoke flow",
      event_data: {
        Image: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        CommandLine: "powershell.exe -NoProfile -Command Write-Host HostEyeDemo",
        ParentImage: "C:\\Windows\\explorer.exe",
        User: "LOCAL-DEMO\\analyst"
      }
    },
    {
      agent_id: agentId,
      host_id: hostId,
      computer,
      timestamp: now,
      channel: "Microsoft-Windows-PowerShell/Operational",
      event_id: 4104,
      record_id: 1002,
      provider_name: "Microsoft-Windows-PowerShell",
      level: "Warning",
      message: "Local demo PowerShell script block event from HostEye smoke flow",
      script_block_text: "Write-Output \"HostEye local demo\"",
      event_data: {
        ScriptBlockText: "Write-Output \"HostEye local demo\"",
        User: "LOCAL-DEMO\\analyst"
      }
    }
  ];

  const eventsJson = JSON.stringify(events);
  const checksum = sha256(eventsJson);
  const chunkId = sha256(`${agentId}|${now}|${checksum}`);
  const batchBytes = Buffer.byteLength(eventsJson, "utf8");

  const admissionResponse = await fetch(`${baseUrl}/api/v1/admission/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      host_id: hostId,
      computer,
      queue_used_mb: 0,
      next_chunk_size_mb: batchBytes / 1024 / 1024,
      retry_count: 0,
      rank: 0
    })
  });
  const admission = await admissionResponse.json();
  if (!admissionResponse.ok) {
    throw new Error(`Admission failed ${admissionResponse.status}: ${JSON.stringify(admission)}`);
  }

  const telemetryResponse = await fetch(`${baseUrl}/api/v1/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol: "hosteye.telemetry.v1",
      schema_version: "1.0.0",
      chunk_id: chunkId,
      agent_id: agentId,
      host_id: hostId,
      computer,
      source_platform: "hosteye_local_demo",
      shipper_version: "local-demo-1.0.0",
      sequence_number: 1,
      event_count: events.length,
      batch_bytes: batchBytes,
      lease_id: admission.lease_id,
      lease_expires_at: admission.lease_expires_at,
      max_batch_mb: admission.max_batch_mb,
      max_upload_rate_kbps: admission.max_upload_rate_kbps,
      checksum,
      checksum_algorithm: "sha256",
      created_at: now,
      events
    })
  });
  const ack = await telemetryResponse.json();

  const result = { agentId, hostId, computer, chunkId, admission, ack };
  console.log(JSON.stringify(result, null, 2));
  if (!telemetryResponse.ok) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
