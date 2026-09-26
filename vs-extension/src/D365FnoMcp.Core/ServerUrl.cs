namespace D365FnoMcp.Core;

public static class ServerUrl
{
    /// <summary>
    /// Base URL of a server: scheme, host, port and path without a trailing slash,
    /// "/mcp", query or fragment. Throws <see cref="FormatException"/> for anything
    /// that is not an absolute http(s) URL.
    /// </summary>
    public static string Normalize(string value)
    {
        if (!Uri.TryCreate(value?.Trim(), UriKind.Absolute, out Uri? uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            throw new FormatException($"'{value}' is not an http(s) URL.");
        }

        string path = uri.AbsolutePath.TrimEnd('/');
        if (path.EndsWith("/mcp", StringComparison.OrdinalIgnoreCase))
        {
            path = path[..^4];
        }

        return $"{uri.Scheme}://{uri.Authority}{path}".TrimEnd('/');
    }

    public static string McpEndpoint(string value) => Normalize(value) + "/mcp";

    /// <summary>True for plain http to anything but this machine, where the API key would travel unencrypted.</summary>
    public static bool IsInsecure(string value)
    {
        var uri = new Uri(Normalize(value));
        return uri.Scheme == Uri.UriSchemeHttp && !uri.IsLoopback;
    }
}
