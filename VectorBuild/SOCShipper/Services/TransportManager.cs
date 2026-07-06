using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SOCShipper.Services
{
    public class TransportManager
    {
        private readonly AdmissionClient _admissionClient;
        private readonly HttpClient _httpClient;
        private readonly string _spoolDirectory;
        private readonly ConfigSynchronizer _configSync;
        private readonly dynamic _state; // Giả định lấy ShipperState từ Program.cs

        public TransportManager(AdmissionClient admissionClient, HttpClient httpClient, string spoolDirectory, ConfigSynchronizer configSync, dynamic state)
        {
            _admissionClient = admissionClient;
            _httpClient = httpClient;
            _spoolDirectory = spoolDirectory;
            _configSync = configSync;
            _state = state; // Checkpoint Manager
        }

        /// <summary>
        /// Thay thế hàm ProcessSpoolOnce cũ. Trách nhiệm duy nhất: Điều phối việc Đọc Queue, Xin phép và Upload.
        /// </summary>
        public async Task<bool> ProcessSpoolOnceAsync(CancellationToken cancellationToken = default)
        {
            var files = Directory.GetFiles(_spoolDirectory, "*.ndjson")
                .OrderBy(File.GetCreationTimeUtc)
                .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            if (files.Length == 0) return false;

            double queueUsedMb = GetDirectorySizeBytes(_spoolDirectory) / (1024.0 * 1024.0);
            
            foreach (var file in files)
            {
                var checkpoint = _state.GetCheckpoint(file);
                double nextChunkSizeMb = Math.Max(0.1, (new FileInfo(file).Length) / (1024.0 * 1024.0));

                // BƯỚC 1: HỎI XIN QUYỀN UPLOAD TỪ CONTROL PLANE
                // Nếu bị từ chối, hàm này tự động chặn lại (ngủ đông) bằng Jitter cho tới khi được OK
                var lease = await _admissionClient.AcquireLeaseAsync(queueUsedMb, nextChunkSizeMb, cancellationToken);
                
                // BƯỚC 2: CẮT FILE (CHỈ LẤY ĐÚNG SỐ LƯỢNG MÀ LEASE CHO PHÉP)
                int maxBytesToRead = (int)((lease.MaxBatchMb ?? 10) * 1024 * 1024);
                var batch = await ReadBatchAsync(file, checkpoint.LineOffset, maxEvents: 5000, maxBytes: maxBytesToRead);
                
                if (batch.Lines.Count == 0)
                {
                    ArchiveFile(file);
                    continue; // Chuyển sang file tiếp theo
                }

                string chunkId = Guid.NewGuid().ToString("n");
                string payload = "[" + string.Join(",", batch.Lines) + "]";
                
                // BƯỚC 3: TÍNH TOÁN CHECKSUM (SHA-256) VÀ GỬI LÊN GATEWAY
                string checksum;
                byte[] payloadBytes = Encoding.UTF8.GetBytes(payload);
                using (var sha256 = SHA256.Create())
                {
                    byte[] hashBytes = sha256.ComputeHash(payloadBytes);
                    checksum = BitConverter.ToString(hashBytes).Replace("-", "").ToLowerInvariant();
                }

                using var content = new ByteArrayContent(payloadBytes);
                content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
                // Note: Ở hệ thống thực tế sẽ Wrap lại bằng GzipContent

                string uploadUrl = _configSync.CurrentDataPlaneUri.TrimEnd('/') + "/api/v1/telemetry";
                using var req = new HttpRequestMessage(HttpMethod.Post, uploadUrl) { Content = content };
                
                // Gắn Chunk Metadata (Chống ghi đè, ghi trùng lặp)
                req.Headers.Add("X-Lease-Id", lease.LeaseId);
                req.Headers.Add("X-Chunk-Id", chunkId);
                req.Headers.Add("X-Checksum", checksum);
                req.Headers.Add("X-Event-Count", batch.Lines.Count.ToString());
                req.Headers.Add("X-Sequence-Number", checkpoint.LineOffset.ToString());

                if (lease.MaxUploadRateKbps.HasValue && lease.MaxUploadRateKbps.Value > 0)
                {
                    Console.WriteLine($"[Transport] Tốc độ bị giới hạn (Throttled) xuống còn: {lease.MaxUploadRateKbps.Value} KB/s");
                    // Tương lai: Triển khai ThrottledStream bọc ngoài payload ở đây
                }

                Console.WriteLine($"[Transport] Tiến hành Upload Chunk {chunkId} (Offset: {checkpoint.LineOffset}, Data: {batch.Lines.Count} events)...");
                
                using var resp = await _httpClient.SendAsync(req, cancellationToken);
                
                // BƯỚC 4: XỬ LÝ PHẢN HỒI
                if (resp.IsSuccessStatusCode)
                {
                    // "Rửa tội" (Reset Rank) bên Admission Client
                    _admissionClient.ReportUploadSuccess();
                    
                    // Cập nhật Bookmark/Checkpoint
                    _state.SetCheckpoint(file, checkpoint.LineOffset + batch.Lines.Count);
                    _state.Save();
                    
                    Console.WriteLine($"[Transport] Thành công (ACK)! Checkpoint mới đã lưu: {checkpoint.LineOffset + batch.Lines.Count}");
                    return true;
                }
                else
                {
                    Console.WriteLine($"[Transport] Thất bại: Mã {(int)resp.StatusCode}. Sẽ retry ở vòng lặp sau.");
                    // Quăng Exception để Vòng lặp chính ngoài Program.cs chạy lại từ đầu (Kích hoạt lại Admission Client để tăng Rank)
                    throw new Exception("Gateway Error"); 
                }
            }

            return false;
        }

        // Logic đọc Batch theo Limit (Không thay đổi, tái cấu trúc từ Program.cs)
        private async Task<(List<string> Lines, int Bytes)> ReadBatchAsync(string file, int skipLines, int maxEvents, int maxBytes)
        {
            var lines = new List<string>();
            var bytes = 2; 
            var index = 0;
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            while (await reader.ReadLineAsync() is { } line)
            {
                if (index++ < skipLines) continue;
                if (string.IsNullOrWhiteSpace(line)) continue;
                
                var lineBytes = Encoding.UTF8.GetByteCount(line) + (lines.Count > 0 ? 1 : 0);
                if (lines.Count > 0 && (lines.Count >= maxEvents || bytes + lineBytes > maxBytes)) break;
                
                lines.Add(line);
                bytes += lineBytes;
                if (lines.Count >= maxEvents || bytes >= maxBytes) break;
            }
            return (lines, bytes);
        }

        private long GetDirectorySizeBytes(string directory)
        {
            if (!Directory.Exists(directory)) return 0;
            long total = 0;
            foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
            {
                try { total += new FileInfo(file).Length; } catch { }
            }
            return total;
        }

        private void ArchiveFile(string file)
        {
            try
            {
                var sentDir = Path.Combine(Path.GetDirectoryName(file)!, "sent");
                Directory.CreateDirectory(sentDir);
                var dest = Path.Combine(sentDir, Path.GetFileName(file) + "." + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss") + ".sent");
                File.Move(file, dest, overwrite: false);
            }
            catch { }
        }
    }
}
