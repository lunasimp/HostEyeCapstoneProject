namespace SOCShipper.Services;

public class FileLogger
{
    private readonly string _path;

    public FileLogger(string path)
    {
        _path = path;
    }

    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Error(string message) => Write("ERROR", message);

    private void Write(string level, string message)
    {
        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(_path)!);
        var line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} {level} {message}";
        System.IO.File.AppendAllText(_path, line + Environment.NewLine);
        Console.WriteLine(line);
    }
}
