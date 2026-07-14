namespace SOCShipper.Models;

public class BackpressureException : Exception
{
    public int StatusCode { get; }
    public int? RetryAfterSeconds { get; }

    public BackpressureException(int statusCode, int? retryAfterSeconds) 
        : base($"Backpressure {statusCode}")
    {
        StatusCode = statusCode;
        RetryAfterSeconds = retryAfterSeconds;
    }
}
