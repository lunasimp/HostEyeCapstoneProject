using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace SOCShipper.Services
{
    public class ConfigSynchronizer
    {
        private readonly HttpClient _httpClient;
        private readonly string _controlPlaneUrl;
        private readonly string _localConfigPath;
        private readonly string _etagFilePath;
        private readonly string _routingFilePath;

        // Lưu giữ địa chỉ Data Plane hiện tại để các module khác sử dụng
        public string CurrentDataPlaneUri { get; private set; } = "https://default-dataplane.yourcorporate.com";

        public ConfigSynchronizer(HttpClient httpClient, string controlPlaneUrl, string localConfigPath)
        {
            _httpClient = httpClient;
            _controlPlaneUrl = controlPlaneUrl;
            _localConfigPath = localConfigPath;
            _etagFilePath = localConfigPath + ".etag"; 
            _routingFilePath = localConfigPath + ".routing";

            // Load Data Plane URI đã lưu từ lần chạy trước (nếu có)
            if (File.Exists(_routingFilePath))
            {
                CurrentDataPlaneUri = File.ReadAllText(_routingFilePath).Trim();
            }
        }

        public async Task<bool> SyncConfigAsync(CancellationToken cancellationToken = default)
        {
            try
            {
                string currentETag = string.Empty;
                if (File.Exists(_etagFilePath))
                {
                    currentETag = await File.ReadAllTextAsync(_etagFilePath, cancellationToken);
                    currentETag = currentETag.Trim();
                }

                using var request = new HttpRequestMessage(HttpMethod.Get, _controlPlaneUrl);
                if (!string.IsNullOrWhiteSpace(currentETag))
                {
                    request.Headers.TryAddWithoutValidation("If-None-Match", currentETag);
                }

                using var response = await _httpClient.SendAsync(request, cancellationToken);

                // Cập nhật Routing Metadata (Data Plane) nếu Server gửi kèm trong Header
                if (response.Headers.TryGetValues("X-Assigned-Data-Plane", out var dpValues))
                {
                    var newDp = dpValues.FirstOrDefault();
                    if (!string.IsNullOrWhiteSpace(newDp) && newDp != CurrentDataPlaneUri)
                    {
                        CurrentDataPlaneUri = newDp;
                        await File.WriteAllTextAsync(_routingFilePath, newDp, cancellationToken);
                        Console.WriteLine($"[ConfigSync] Đã cập nhật Routing! Data Plane mới: {newDp}");
                    }
                }

                if (response.StatusCode == HttpStatusCode.NotModified)
                {
                    Console.WriteLine($"[ConfigSync] Cấu hình không đổi (ETag: {currentETag}).");
                    return false;
                }

                if (response.IsSuccessStatusCode)
                {
                    var newETag = response.Headers.ETag?.Tag;
                    var configContent = await response.Content.ReadAsStringAsync(cancellationToken);

                    string tempConfigPath = _localConfigPath + ".tmp";
                    await File.WriteAllTextAsync(tempConfigPath, configContent, cancellationToken);
                    File.Move(tempConfigPath, _localConfigPath, overwrite: true); 

                    if (!string.IsNullOrWhiteSpace(newETag))
                    {
                        string tempEtagPath = _etagFilePath + ".tmp";
                        await File.WriteAllTextAsync(tempEtagPath, newETag, cancellationToken);
                        File.Move(tempEtagPath, _etagFilePath, overwrite: true);
                    }

                    Console.WriteLine($"[ConfigSync] Tải thành công cấu hình mới! ETag: {newETag}");
                    return true;
                }

                Console.WriteLine($"[ConfigSync] Lỗi từ Server: {(int)response.StatusCode} {response.ReasonPhrase}");
                return false;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[ConfigSync] Ngoại lệ kết nối: {ex.Message}");
                return false;
            }
        }
    }
}
