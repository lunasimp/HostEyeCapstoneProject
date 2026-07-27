# HostEye MSI Bootstrap Installer

This folder contains the Windows MSI packaging skeleton for HostEye Endpoint Agent.

The MSI is a Windows-native bootstrap package. It copies the HostEye payload to `C:\Program Files\HostEye`, then runs `install.ps1` as LocalSystem/admin context through a deferred custom action.

## Build

```powershell
.\Installer\HostEyeMsi\build-msi.ps1 -SourceDir .\VectorBuild -GatewayUri "https://agent.hosteye.iahn.hanoi.vn/api/v1/telemetry"
```

Required before build:

```powershell
dotnet tool install --global wix
```

The build script validates that the payload exists first, including `vector.exe`, HostEyeShipper publish output, certs, and Sysmon files. This prevents producing a broken MSI.

## Current role in the C_i design

This MSI is the Windows public bootstrap installer. The later production flow should replace or extend `install.ps1` so it calls HostEye enrollment, receives signed `C_i`, downloads the per-device artifact, verifies Ed25519 signatures and SHA256, then installs the personalized agent binary.

## Code signing

For production, sign with an OV/EV or enterprise code-signing certificate trusted by the target endpoints. For local demo machines, you can create and trust a temporary self-signed certificate:

```powershell
# Run elevated if you want the certificate trusted by LocalMachine.
.\Installer\CodeSigning\New-HostEyeDemoCodeSigningCert.ps1 -TrustForLocalMachine
```

Then build a signed MSI:

```powershell
.\Installer\HostEyeMsi\build-signed-msi.ps1 -CertificateThumbprint "<thumbprint>"
```

The signed build signs `VectorBuild\vector.exe`, `VectorBuild\SOCShipper\publish\HostEyeShipper.exe`, `HostEyeShipper.dll`, and the final `HostEyeBootstrap.msi`.

