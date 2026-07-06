using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;
using SOCShipper.Models;

namespace SOCShipper.Services
{
    public class AdmissionClient
    {
        private readonly HttpClient _httpClient;
        private readonly ConfigSynchronizer _configSync;
        private readonly string _clientId;
        private readonly JitterScheduler _jitterScheduler;

        // Lưu giữ trạng thái (State) của Client
        private int _retryCount = 0;
        private DateTimeOffset? _lastSuccessTime = null;

        public AdmissionClient(HttpClient httpClient, ConfigSynchronizer configSync, string clientId, JitterScheduler jitterScheduler)
        {
            _httpClient = httpClient;
            _configSync = configSync;
            _clientId = clientId;
            _jitterScheduler = jitterScheduler;
        }

        /// <summary>
        /// Gửi yêu cầu xin quyền Upload. Hàm này sẽ chặn (block) bằng Delay nếu bị NG, 
        /// và chỉ trả về (return) khi Server đã đồng ý cấp Lease (OK).
        /// </summary>
        public async Task<UploadLease> AcquireLeaseAsync(double queueUsedMb, double nextChunkSizeMb, CancellationToken cancellationToken = default)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                // Lấy URL Data Plane mới nhất từ ConfigSynchronizer
                string requestLeaseUrl = _configSync.CurrentDataPlaneUri.TrimEnd('/') + "/api/v1/telemetry/request-lease";
                // 1. Tạo gói xin phép (Permission Request)
                var requestPayload = new PermissionRequest
                {
                    ClientId = _clientId,
                    QueueUsedMb = queueUsedMb,
                    NextChunkSizeMb = nextChunkSizeMb,
                    RetryCount = _retryCount,
                    Rank = _retryCount, // Trong phiên bản MVP, rank được tính bằng retry_count
                    LastSuccessTime = _lastSuccessTime
                };

                try
                {
                    // 2. Gửi lên Gateway (Data Plane hiện hành)
                    var response = await _httpClient.PostAsJsonAsync(requestLeaseUrl, requestPayload, cancellationToken);
                    
                    // 3. Phân tích kết quả
                    if (response.IsSuccessStatusCode)
                    {
                        var lease = await response.Content.ReadFromJsonAsync<UploadLease>(cancellationToken: cancellationToken);
                        
                        // Server phản hồi trạng thái OK (Admission duyệt)
                        if (lease != null && lease.Status == "OK")
                        {
                            Console.WriteLine($"[Admission] Được duyệt (OK)! LeaseID: {lease.LeaseId}, Cho phép gửi tối đa: {lease.MaxBatchMb}MB");
                            return lease; // Thoát vòng lặp, đi gửi hàng thật
                        }
                        
                        // Server chủ động phản hồi trạng thái NG
                        if (lease != null && lease.Status == "NG")
                        {
                            Console.WriteLine($"[Admission] Bị Server từ chối duyệt (NG). Lý do: {lease.Reason}");
                        }
                    }
                    else
                    {
                        // Lỗi cấu hình mạng hoặc Handler Overload trả về mã lỗi 429 Too Many Requests
                        Console.WriteLine($"[Admission] Lỗi máy chủ ({(int)response.StatusCode}). Server đang bận.");
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[Admission] Lỗi mạng mất kết nối: {ex.Message}");
                }

                // 4. LUỒNG XỬ LÝ KHI BỊ TỪ CHỐI (NG) HOẶC LỖI MẠNG
                _retryCount++; // Tăng Retry, đồng thời Rank cũng tăng lên ở vòng lặp sau
                
                // Lấy Jitter ngẫu nhiên từ JitterScheduler (Càng retry nhiều thời gian chờ tối đa càng tăng)
                TimeSpan delay = _jitterScheduler.GetRetryDelay(_retryCount);
                
                Console.WriteLine($"[Admission] Đã bị từ chối {_retryCount} lần. Rank ưu tiên sẽ được thăng cấp. Đang lùi lại (Sleep) {delay.TotalSeconds} giây...");
                
                await Task.Delay(delay, cancellationToken);
            }
            
            throw new OperationCanceledException("Hành động xin phép đã bị hủy bỏ bởi hệ thống.");
        }

        /// <summary>
        /// Gọi hàm này khi Data Plane phản hồi ACK thành công ở chặng Upload.
        /// Giúp Client "tẩy thẻ", đưa Rank về mức thấp nhất.
        /// </summary>
        public void ReportUploadSuccess()
        {
            _retryCount = 0;
            _lastSuccessTime = DateTimeOffset.UtcNow;
            Console.WriteLine("[Admission] Gửi Chunk thành công! Hệ thống đã Reset Rank và Retry Count về 0.");
        }
    }
}
