# HostEye Demo Lab

This folder automates a five-endpoint HostEye demo lab on one Windows host.

The intended model is:

1. Create one clean Windows 11 VM template in VirtualBox.
2. Install VirtualBox Guest Additions inside the template.
3. Enable a local admin account that the scripts can use.
4. Create a clean snapshot.
5. Run `start-demo-lab.ps1` to clone five linked endpoint VMs, start the server pipeline, install HostEye Agent, and run smoke checks.

## Requirements

- Windows host with enough memory. For the default five VMs, allocate at least 20 GB RAM for guests.
- Docker Desktop.
- VirtualBox with `VBoxManage.exe` available.
- A Windows 11 template VM with a snapshot.
- HostEye installer built at `VectorBuild/Output/HostEye_Endpoint_Installer.exe`, or update `InstallerRelativePath`.

## First-time setup

Edit `config.demo.json`:

- `TemplateVmName`: the exact VirtualBox template VM name.
- `TemplateSnapshotName`: snapshot to clone from.
- `BridgeAdapterName`: your real bridge adapter name. Leave blank to keep VirtualBox default.
- `GuestUsername` and `GuestPassword`: local admin user inside the Windows template.
- `GatewayIp`: optional. If set, the script writes a hosts entry inside each VM.

Example bridge adapter names can be listed with:

```powershell
VBoxManage list bridgedifs
```

## Commands

Check host prerequisites and config:

```powershell
.\HostEyeDemoLab\prepare-host.ps1
```

Create/start the lab and install HostEye Agent:

```powershell
.\HostEyeDemoLab\start-demo-lab.ps1
```

Run smoke tests:

```powershell
.\HostEyeDemoLab\test-demo-lab.ps1
```

Stop VMs without deleting them:

```powershell
.\HostEyeDemoLab\stop-demo-lab.ps1
```

Delete the five linked clones and recreate from the template next run:

```powershell
.\HostEyeDemoLab\reset-demo-lab.ps1
```

## Safety

The reset script only removes VMs whose names match `VmNamePrefix-01..VmNamePrefix-05` from `config.demo.json`.
It does not remove the template VM.

