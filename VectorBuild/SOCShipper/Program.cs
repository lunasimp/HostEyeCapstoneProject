using SOCShipper.Models;
using SOCShipper.Services;

var configPath = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "shipper-config.json");
var config = ShipperConfig.Load(configPath);
Directory.CreateDirectory(config.SpoolDirectory);
Directory.CreateDirectory(config.StateDirectory);
Directory.CreateDirectory(config.LogDirectory);
var logger = new FileLogger(Path.Combine(config.LogDirectory, "shipper.log"));
var state = ShipperState.Load(Path.Combine(config.StateDirectory, "shipper-state.json"));
var jitterScheduler = new JitterScheduler();

var endpointSeed = Environment.GetEnvironmentVariable("HOSTEYE_AGENT_ID")
    ?? Environment.GetEnvironmentVariable("VECTOR_AGENT_ID")
    ?? Environment.MachineName
    ?? Guid.NewGuid().ToString("n");

logger.Info($"HostEyeShipper starting. Config={configPath} Spool={config.SpoolDirectory} Gateway={config.GatewayUri}");
using var http = Utilities.BuildHttpClient(config, logger);

if (config.StartupJitterWindowSeconds > 0)
{
    var startupJitter = jitterScheduler.GetStartupDelay(config.StartupJitterWindowSeconds);
    if (startupJitter > TimeSpan.Zero)
    {
        logger.Info($"Applying startup jitter of {startupJitter.TotalSeconds}s before contacting server.");
        await Task.Delay(startupJitter);
    }
}

var configSync = new ConfigSynchronizer(config, http, state, logger, jitterScheduler);
var admissionClient = new AdmissionClient(config, http, logger, state);
var spoolQuotaManager = new SpoolQuotaManager();
var transportManager = new TransportManager(config, state, http, logger, admissionClient, spoolQuotaManager, jitterScheduler, endpointSeed);

await configSync.TrySyncAgentConfigAsync();
state.Save();

using var cleanupCts = new CancellationTokenSource();

var cleanupTask = config.MaxSpoolSizeMB > 0
    ? RunSpoolQuotaLoop(config, spoolQuotaManager, logger, cleanupCts.Token)
    : Task.CompletedTask;

var configSyncTask = config.EnableConfigSync && !config.RunOnce
    ? RunPeriodicConfigSyncLoop(config, configSync, state, logger, jitterScheduler, cleanupCts.Token)
    : Task.CompletedTask;

var attempt = 0;

try
{
    while (true)
    {
        try
        {
            var sentAny = await transportManager.ProcessSpoolOnceAsync(attempt);
            if (sentAny)
            {
                attempt = 0;
                if (config.RunOnce)
                {
                    logger.Info("RunOnce completed after one successful batch.");
                    return 0;
                }
            }
            else if (config.RunOnce)
            {
                logger.Info("RunOnce completed; no pending spool data.");
                return 0;
            }
            else
            {
                var heartbeatDelay = jitterScheduler.GetPeriodicDelay(config.HeartbeatIntervalSeconds, config.HeartbeatJitterSeconds);
                logger.Info($"Spool is empty. Sleeping for heartbeat periodic jitter: {heartbeatDelay.TotalSeconds}s.");
                await Task.Delay(heartbeatDelay);
            }
        }
        catch (BackpressureException ex)
        {
            attempt++;
            var retryAfter = ex.RetryAfterSeconds ?? 0;
            var delay = retryAfter > 0
                ? TimeSpan.FromSeconds(retryAfter + jitterScheduler.RandomInt(0, 30))
                : jitterScheduler.FullJitterDelay(config.BaseBackoffSeconds, config.MaxBackoffSeconds, attempt);
            logger.Info($"Backpressure/status={ex.StatusCode}; delaying {delay.TotalSeconds:F0}s attempt={attempt}.");
            if (config.RunOnce) return 2;
            await Task.Delay(delay);
        }
        catch (Exception ex)
        {
            attempt++;
            var delay = jitterScheduler.FullJitterDelay(config.BaseBackoffSeconds, config.MaxBackoffSeconds, attempt);
            logger.Error($"Unhandled shipper error: {ex}; delaying {delay.TotalSeconds:F0}s attempt={attempt}.");
            if (config.RunOnce) return 1;
            await Task.Delay(delay);
        }
    }
}
finally
{
    await StopCleanupLoop(cleanupCts, cleanupTask, configSyncTask, logger);
}

static async Task RunPeriodicConfigSyncLoop(ShipperConfig config, ConfigSynchronizer configSync, ShipperState state, FileLogger logger, JitterScheduler jitter, CancellationToken token)
{
    logger.Info($"Periodic config sync loop enabled. Interval={config.ConfigSyncIntervalSeconds}s Jitter={config.ConfigSyncJitterSeconds}s.");
    while (!token.IsCancellationRequested)
    {
        try
        {
            var delay = jitter.GetPeriodicDelay(config.ConfigSyncIntervalSeconds, config.ConfigSyncJitterSeconds);
            await Task.Delay(delay, token);
            await configSync.TrySyncAgentConfigAsync();
            state.Save();
        }
        catch (OperationCanceledException)
        {
            break;
        }
        catch (Exception ex)
        {
            logger.Warn($"Periodic config sync loop error: {ex.Message}");
            await Task.Delay(TimeSpan.FromSeconds(60), token);
        }
    }
}

static async Task RunSpoolQuotaLoop(ShipperConfig config, SpoolQuotaManager spoolQuotaManager, FileLogger logger, CancellationToken token)
{
    logger.Info($"Spool quota loop enabled. MaxSpoolSizeMB={config.MaxSpoolSizeMB} LowWatermarkPercent={config.LowWatermarkPercent} CheckIntervalSeconds={config.SpoolCheckIntervalSeconds} PreferDeletingSentFirst={config.PreferDeletingSentFirst} SentRetentionDays={config.SentRetentionDays}.");
    while (!token.IsCancellationRequested)
    {
        try
        {
            spoolQuotaManager.EnforceSpoolPolicy(config, logger);
        }
        catch (Exception ex)
        {
            logger.Warn($"Spool quota check failed: {ex.Message}");
        }

        try
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, config.SpoolCheckIntervalSeconds)), token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
    }
}

static async Task StopCleanupLoop(CancellationTokenSource cleanupCts, Task cleanupTask, Task configSyncTask, FileLogger logger)
{
    try
    {
        cleanupCts.Cancel();
        await Task.WhenAll(cleanupTask, configSyncTask);
    }
    catch (OperationCanceledException)
    {
    }
    catch (Exception ex)
    {
        logger.Warn($"Background tasks stopped with error: {ex.Message}");
    }
}
