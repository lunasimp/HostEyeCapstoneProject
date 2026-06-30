[Setup]
AppName=HostEye Endpoint Agent
#define BuildRoot SourcePath
AppPublisher=FPT
AppPublisherURL=https://iahn.fpt.edu.vn/du-an/HostEye
AppSupportURL=https://iahn.fpt.edu.vn/du-an/HostEye
AppVersion=1.0
DefaultDirName={commonpf}\HostEye
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir={#BuildRoot}\Output
OutputBaseFilename=HostEye_Endpoint_Installer
Compression=lzma
SolidCompression=yes
PrivilegesRequired=admin
CreateAppDir=yes
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern
WizardImageFile={#BuildRoot}\branding\HostEye-wizard.bmp
WizardSmallImageFile={#BuildRoot}\branding\HostEye-small.bmp
SetupIconFile={#BuildRoot}\branding\HostEye.ico
UninstallDisplayIcon={app}\vector.exe
SetupLogging=yes

[Files]
Source: "{#BuildRoot}\vector.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\vector.toml"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\vector.toml.sig"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\collector-policy.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\SOC_Updater.ps1"; DestDir: "{app}"; DestName: "HostEye_Updater.ps1"; Flags: ignoreversion
Source: "{#BuildRoot}\install.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\Pause-HostEyeDemoCollection.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\Resume-HostEyeDemoCollection.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildRoot}\SOCShipper\publish\*"; DestDir: "{app}\HostEyeShipper"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#BuildRoot}\certs\*"; DestDir: "{app}\certs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#BuildRoot}\Sysmon\Sysmon64.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "{#BuildRoot}\Sysmon\Sysmon.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "{#BuildRoot}\Sysmon\Sysmon64a.exe"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "{#BuildRoot}\Sysmon\Eula.txt"; DestDir: "{app}\Sysmon"; Flags: ignoreversion
Source: "{#BuildRoot}\Sysmon\soc-sysmon-config.xml"; DestDir: "{app}\Sysmon"; DestName: "hosteye-sysmon-config.xml"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; Parameters: "-ExecutionPolicy Bypass -File ""{app}\install.ps1"""; Description: "Cài đặt HostEye Endpoint Agent"; Flags: runhidden waituntilterminated
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
    'Start-Sleep -Seconds 3; ' +
    'taskkill /F /IM HostEyeShipper.exe; taskkill /F /IM SOCShipper.exe; ' +
    'taskkill /F /IM vector.exe' +
    '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopOldAgentBeforeFileCopy();
  Result := '';
end;


[Messages]
SetupAppTitle=Cài đặt HostEye Endpoint Agent
SetupWindowTitle=Cài đặt HostEye Endpoint Agent
AdminPrivilegesRequired=Bạn cần đăng nhập bằng tài khoản quản trị viên để cài đặt HostEye Endpoint Agent.
ExitSetupTitle=Thoát trình cài đặt
ExitSetupMessage=Quá trình cài đặt chưa hoàn tất. Nếu thoát bây giờ, HostEye Endpoint Agent sẽ chưa được cài đặt.%n%nBạn có chắc muốn thoát không?
ButtonBack=< &Quay lại
ButtonNext=&Tiếp tục >
ButtonInstall=&Cài đặt
ButtonCancel=Hủy
ButtonFinish=&Hoàn tất
ButtonBrowse=&Duyệt...
ButtonOK=Đồng ý
ButtonYes=&Có
ButtonNo=&Không
WelcomeLabel1=Chào mừng đến với trình cài đặt HostEye Endpoint Agent
WelcomeLabel2=Trình cài đặt sẽ triển khai HostEye Endpoint Agent của FPT lên máy trạm này.%n%nBạn nên đóng các ứng dụng khác trước khi tiếp tục.
WizardReady=Sẵn sàng cài đặt
ReadyLabel1=Trình cài đặt đã sẵn sàng cài đặt HostEye Endpoint Agent trên máy tính của bạn.
ReadyLabel2a=Nhấn Cài đặt để tiếp tục, hoặc nhấn Quay lại nếu bạn muốn xem lại hay thay đổi thiết lập.
ReadyLabel2b=Nhấn Cài đặt để bắt đầu quá trình cài đặt.
ReadyMemoDir=Thư mục cài đặt:
ReadyMemoGroup=Thư mục Start Menu:
ReadyMemoTasks=Tác vụ bổ sung:
WizardPreparing=Đang chuẩn bị cài đặt
PreparingDesc=Trình cài đặt đang chuẩn bị cài đặt HostEye Endpoint Agent trên máy tính của bạn.
WizardInstalling=Đang cài đặt
InstallingLabel=Vui lòng chờ trong khi HostEye Endpoint Agent được cài đặt trên máy tính của bạn.
FinishedHeadingLabel=Hoàn tất cài đặt HostEye Endpoint Agent
FinishedLabelNoIcons=HostEye Endpoint Agent đã được cài đặt trên máy tính của bạn.
FinishedLabel=HostEye Endpoint Agent đã được cài đặt. Dịch vụ sẽ tự động thu thập và gửi telemetry bảo mật endpoint.
FinishedRestartLabel=Để hoàn tất cài đặt HostEye Endpoint Agent, máy tính cần được khởi động lại. Bạn có muốn khởi động lại ngay không?
FinishedRestartMessage=Để hoàn tất cài đặt HostEye Endpoint Agent, máy tính cần được khởi động lại.%n%nBạn có muốn khởi động lại ngay không?
SetupAlreadyRunning=Trình cài đặt HostEye Endpoint Agent đang chạy.
SetupAborted=Quá trình cài đặt chưa hoàn tất.%n%nVui lòng chạy lại trình cài đặt khi bạn muốn tiếp tục.
