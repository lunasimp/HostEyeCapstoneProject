using SOCShipper.Models;

namespace SOCShipper.Services;

public class SpoolQuotaManager
{
    public void EnforceSpoolPolicy(ShipperConfig config, FileLogger logger)
    {
        try
        {
            DeleteExpiredSentFiles(config, logger);

            var maxBytes = config.MaxSpoolSizeMB <= 0 ? 0 : config.MaxSpoolSizeMB * 1024L * 1024L;
            if (maxBytes <= 0) return;

            var lowWatermarkPercent = Math.Clamp(config.LowWatermarkPercent, 1, 100);
            var targetBytes = Math.Max(0, maxBytes * lowWatermarkPercent / 100L);
            var totalBytes = GetDirectorySizeBytes(config.SpoolDirectory);
            if (totalBytes <= maxBytes) return;

            logger.Info($"Spool size {totalBytes} bytes exceeds max {maxBytes} bytes; trimming to {targetBytes} bytes.");
            foreach (var file in GetDeletionCandidates(config))
            {
                if (totalBytes <= targetBytes) break;
                try
                {
                    var length = new FileInfo(file.FullName).Length;
                    File.Delete(file.FullName);
                    totalBytes -= length;
                    if (file.IsSent)
                    {
                        logger.Info($"Deleted sent spool file {file.FullName} ({length} bytes) to enforce spool limit.");
                    }
                    else
                    {
                        logger.Warn($"Dropped unsent spool file {file.FullName} ({length} bytes) to enforce spool limit. DATA_LOSS=true");
                    }
                }
                catch (Exception ex)
                {
                    logger.Info($"Spool cleanup skipped {file.FullName}: {ex.Message}");
                }
            }
        }
        catch (Exception ex)
        {
            logger.Info($"Spool policy check failed: {ex.Message}");
        }
    }

    private void DeleteExpiredSentFiles(ShipperConfig config, FileLogger logger)
    {
        if (config.SentRetentionDays < 0) return;
        var sentDir = Path.Combine(config.SpoolDirectory, "sent");
        if (!Directory.Exists(sentDir)) return;

        var cutoffUtc = DateTimeOffset.UtcNow.AddDays(-config.SentRetentionDays);
        foreach (var file in Directory.EnumerateFiles(sentDir, "*", SearchOption.TopDirectoryOnly))
        {
            try
            {
                var info = new FileInfo(file);
                if (info.LastWriteTimeUtc > cutoffUtc.UtcDateTime) continue;
                info.Delete();
                logger.Info($"Deleted sent spool file past retention: {file}");
            }
            catch (Exception ex)
            {
                logger.Info($"Sent retention cleanup skipped {file}: {ex.Message}");
            }
        }
    }

    public long GetDirectorySizeBytes(string directory)
    {
        if (!Directory.Exists(directory)) return 0;
        long total = 0;
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            try { total += new FileInfo(file).Length; } catch { }
        }
        return total;
    }

    public SpoolStats GetSpoolStats(string directory)
    {
        if (!Directory.Exists(directory)) return new SpoolStats(0, 0, 0);
        long bytes = 0;
        var fileCount = 0;
        var pendingFileCount = 0;
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            try
            {
                var info = new FileInfo(file);
                bytes += info.Length;
                fileCount++;
                if (string.Equals(info.Extension, ".ndjson", StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(info.Directory?.FullName, directory, StringComparison.OrdinalIgnoreCase))
                {
                    pendingFileCount++;
                }
            }
            catch
            {
            }
        }
        return new SpoolStats(bytes, fileCount, pendingFileCount);
    }

    private IEnumerable<QuotaFile> GetDeletionCandidates(ShipperConfig config)
    {
        var sentDir = Path.Combine(config.SpoolDirectory, "sent");
        if (config.PreferDeletingSentFirst && Directory.Exists(sentDir))
        {
            foreach (var file in Directory.EnumerateFiles(sentDir, "*", SearchOption.TopDirectoryOnly)
                .OrderBy(File.GetLastWriteTimeUtc)
                .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
            {
                yield return new QuotaFile(file, true);
            }
        }

        if (!Directory.Exists(config.SpoolDirectory)) yield break;
        foreach (var file in Directory.EnumerateFiles(config.SpoolDirectory, "*.ndjson", SearchOption.TopDirectoryOnly)
            .OrderBy(File.GetCreationTimeUtc)
            .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
        {
            yield return new QuotaFile(file, false);
        }

        if (!config.PreferDeletingSentFirst && Directory.Exists(sentDir))
        {
            foreach (var file in Directory.EnumerateFiles(sentDir, "*", SearchOption.TopDirectoryOnly)
                .OrderBy(File.GetLastWriteTimeUtc)
                .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
            {
                yield return new QuotaFile(file, true);
            }
        }
    }
}
