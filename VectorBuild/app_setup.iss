[Setup]
AppName=SOC Vector Agent
AppVersion=1.0
DefaultDirName={commonpf}\Vector
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=C:\VectorBuild\Output
OutputBaseFilename=SOC_Agent_Installer
Compression=lzma
SolidCompression=yes
PrivilegesRequired=admin
CreateAppDir=yes
ArchitecturesInstallIn64BitMode=x64

[Files]
Source: "C:\VectorBuild\vector.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\VectorBuild\vector.toml"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\VectorBuild\vector.toml.sig"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\VectorBuild\SOC_Updater.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\VectorBuild\install.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\VectorBuild\SOCShipper\publish\*"; DestDir: "{app}\SOCShipper"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "C:\VectorBuild\certs\*"; DestDir: "{app}\certs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "C:\VectorBuild\Sysmon\Sysmon64.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "C:\VectorBuild\Sysmon\Sysmon.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "C:\VectorBuild\Sysmon\Sysmon64a.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "C:\VectorBuild\Sysmon\Eula.txt"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "C:\VectorBuild\Sysmon\soc-sysmon-config.xml"; DestDir: "{app}\Sysmon"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install.ps1"""; Flags: runhidden waituntilterminated
[Code]
procedure StopOldAgentBeforeFileCopy();
var
  ResultCode: Integer;
begin
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -Command "' +
    '$ErrorActionPreference=''SilentlyContinue''; ' +
    'Stop-ScheduledTask -TaskName SOC_Shipper_Startup; ' +
    'Stop-ScheduledTask -TaskName SOC_Vector_Startup; ' +
    'Stop-ScheduledTask -TaskName SOC_Agent_Updater; ' +
    'Stop-Service -Name SOCShipper -Force; ' +
    'Stop-Service -Name Vector -Force; ' +
    'Start-Sleep -Seconds 3; ' +
    'taskkill /F /IM SOCShipper.exe; ' +
    'taskkill /F /IM vector.exe' +
    '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopOldAgentBeforeFileCopy();
  Result := '';
end;

