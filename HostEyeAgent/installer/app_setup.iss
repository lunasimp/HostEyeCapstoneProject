#define BuildRoot SourcePath + "\.."
#ifndef InstallerOutputBaseFilename
#define InstallerOutputBaseFilename "HostEye_Endpoint_Installer"
#endif
#ifndef InstallerGatewayUri
#define InstallerGatewayUri "https://hosteye.iahn.hanoi.vn/api/v1/telemetry"
#endif
#ifndef InstallerConfigUri
#define InstallerConfigUri "https://hosteye.iahn.hanoi.vn/api/v1/agent/config"
#endif
#ifndef InstallerAdmissionUri
#define InstallerAdmissionUri "https://hosteye.iahn.hanoi.vn/api/v1/admission/request"
#endif
#ifndef InstallerRegistrationUri
#define InstallerRegistrationUri "https://hosteye.iahn.hanoi.vn/api/v1/enroll"
#endif
#ifndef InstallerBootstrapSigningKey
#define InstallerBootstrapSigningKey "hosteye-bootstrap-demo-signing-key-change-me"
#endif
#ifndef InstallerStartupJitterWindowSeconds
#define InstallerStartupJitterWindowSeconds "300"
#endif
#ifndef InstallerSettingsFile
#define InstallerSettingsFile BuildRoot + "\installer\generated-installer-settings.json"
#endif

[Setup]
AppName=HostEye Endpoint Agent
AppPublisher=FPT
AppPublisherURL=https://iahn.fpt.edu.vn/du-an/HostEye
AppSupportURL=https://iahn.fpt.edu.vn/du-an/HostEye
AppVersion=1.0.0
DefaultDirName={commonpf}\HostEye
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir={#BuildRoot}\Output
OutputBaseFilename={#InstallerOutputBaseFilename}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
CreateAppDir=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
WizardImageFile={#BuildRoot}\installer\branding\HostEye-wizard.bmp
WizardSmallImageFile={#BuildRoot}\installer\branding\HostEye-small.bmp
SetupIconFile={#BuildRoot}\installer\branding\HostEye.ico
UninstallDisplayIcon={app}\vector.exe
SetupLogging=yes
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#BuildRoot}\vector\vector.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\vector\vector.toml"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\vector\vector.toml.sig"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\policy\collector-policy.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\scripts\SOC_Updater.ps1"; DestDir: "{app}"; DestName: "HostEye_Updater.ps1"; Flags: ignoreversion
Source: "{#BuildRoot}\scripts\install.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\scripts\Enroll-HostEyeEndpoint.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\scripts\uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\scripts\Pause-HostEyeDemoCollection.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\scripts\Resume-HostEyeDemoCollection.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#InstallerSettingsFile}"; DestDir: "{app}"; DestName: "installer-settings.json"; Flags: ignoreversion
Source: "{#BuildRoot}\shipper\target\release\hosteye-shipper.exe"; DestDir: "{app}\HostEyeShipper"; DestName: "HostEyeShipper.exe"; Flags: ignoreversion
Source: "{#BuildRoot}\shipper\tools\nssm.exe"; DestDir: "{app}\HostEyeShipper\tools"; Flags: ignoreversion
Source: "{#BuildRoot}\certs\*"; DestDir: "{app}\certs"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "{#BuildRoot}\sysmon\Sysmon.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "{#BuildRoot}\sysmon\Sysmon64.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "{#BuildRoot}\sysmon\Sysmon64a.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "{#BuildRoot}\sysmon\Eula.txt"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "{#BuildRoot}\sysmon\soc-sysmon-config.xml"; DestDir: "{app}\Sysmon"; DestName: "hosteye-sysmon-config.xml"; Flags: ignoreversion

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "HostEyeCleanup"

[Code]
procedure StopOldAgentBeforeFileCopy();
var
  ResultCode: Integer;
begin
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "' +
    '$ErrorActionPreference=''SilentlyContinue''; ' +
    'Stop-ScheduledTask -TaskName HostEye_Shipper_Startup; Stop-ScheduledTask -TaskName SOC_Shipper_Startup; ' +
    'Stop-ScheduledTask -TaskName HostEye_Agent_Startup; Stop-ScheduledTask -TaskName SOC_Vector_Startup; ' +
    'Stop-ScheduledTask -TaskName HostEye_Agent_Updater; Stop-ScheduledTask -TaskName SOC_Agent_Updater; ' +
    'Stop-Service -Name HostEyeShipper -Force; Stop-Service -Name SOCShipper -Force; ' +
    'Stop-Service -Name HostEyeAgent -Force; Stop-Service -Name Vector -Force; ' +
    'Start-Sleep -Seconds 2; ' +
    'taskkill /F /IM hosteye-shipper.exe; taskkill /F /IM HostEyeShipper.exe; ' +
    'taskkill /F /IM vector.exe' +
    '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopOldAgentBeforeFileCopy();
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Parameters: String;
  CompletionMarker: String;
begin
  if CurStep = ssPostInstall then
  begin
    CompletionMarker := ExpandConstant('{commonappdata}\HostEye\install-complete.json');
    DeleteFile(CompletionMarker);
    Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\install.ps1') + '"' +
      ' -RegistrationUri "{#InstallerRegistrationUri}"' +
      ' -BootstrapSigningKey "{#InstallerBootstrapSigningKey}"' +
      ' -EnrollmentToken "' + ExpandConstant('{param:ENROLLMENTTOKEN|}') + '"';
    if (not Exec('powershell.exe', Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
       (ResultCode <> 0) then
      RaiseException(Format('HostEye endpoint service installation failed (exit code %d). See C:\ProgramData\HostEye\logs\install.log.', [ResultCode]));
    if not FileExists(CompletionMarker) then
      RaiseException('HostEye endpoint service installation did not produce its completion marker. See C:\ProgramData\HostEye\logs\install.log.');
  end;
end;

[Messages]
SetupAppTitle=HostEye Endpoint Agent Setup
SetupWindowTitle=HostEye Endpoint Agent Setup
AdminPrivilegesRequired=Administrator privileges are required to install HostEye Endpoint Agent.
WelcomeLabel1=Welcome to HostEye Endpoint Agent Setup
WelcomeLabel2=Setup installs the HostEye collector, durable shipper, telemetry policy, and Sysmon prerequisites on this endpoint.%n%nClose other applications before continuing.
FinishedHeadingLabel=HostEye Endpoint Agent installation completed
FinishedLabel=HostEye Endpoint Agent and HostEye Shipper have been installed. The services will collect and deliver endpoint telemetry according to the configured gateway policy.
