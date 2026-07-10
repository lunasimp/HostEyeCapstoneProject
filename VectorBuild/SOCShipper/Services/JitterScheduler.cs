using System.Security.Cryptography;
using System.Text;

namespace SOCShipper.Services;

public class JitterScheduler
{
    private readonly RandomNumberGenerator _rng = RandomNumberGenerator.Create();

    public TimeSpan GetStartupDelay(int windowSeconds)
    {
        if (windowSeconds <= 0) return TimeSpan.Zero;
        return TimeSpan.FromSeconds(RandomInt(0, windowSeconds));
    }

    public (TimeSpan Delay, int WindowSeconds) GetSendDelay(string file, long startByteOffset, string endpointSeed, int normalWindow, int recoveryWindow)
    {
        var window = startByteOffset == 0 
            ? normalWindow 
            : Math.Min(recoveryWindow, Math.Max(normalWindow, recoveryWindow));
        
        if (window <= 0) return (TimeSpan.Zero, window);
        
        var seed = $"{endpointSeed}:{Path.GetFileName(file)}:{startByteOffset}";
        return (TimeSpan.FromSeconds(StableJitterSeconds(seed, window)), window);
    }

    public TimeSpan GetPeriodicDelay(int baseSeconds, int jitterSeconds)
    {
        var jitterOffset = jitterSeconds > 0 ? RandomInt(-jitterSeconds, jitterSeconds) : 0;
        var delaySeconds = Math.Max(1, baseSeconds + jitterOffset);
        return TimeSpan.FromSeconds(delaySeconds);
    }

    private int StableJitterSeconds(string seed, int windowSeconds)
    {
        if (windowSeconds <= 0) return 0;
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        return (int)(BitConverter.ToUInt32(hash, 0) % (uint)windowSeconds);
    }

    public TimeSpan FullJitterDelay(int baseSeconds, int capSeconds, int attempt)
    {
        var max = Math.Min(capSeconds, baseSeconds * Math.Pow(2, Math.Min(attempt, 16)));
        return TimeSpan.FromSeconds(RandomInt(0, Math.Max(1, (int)Math.Ceiling(max))));
    }

    public int RandomInt(int minInclusive, int maxExclusive)
    {
        if (maxExclusive <= minInclusive) return minInclusive;
        Span<byte> bytes = stackalloc byte[4];
        _rng.GetBytes(bytes);
        var value = BitConverter.ToUInt32(bytes);
        return minInclusive + (int)(value % (uint)(maxExclusive - minInclusive));
    }
}
