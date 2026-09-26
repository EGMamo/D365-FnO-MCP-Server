namespace D365FnoMcp.Core;

/// <summary>Builds the connection string <c>index-xref</c> reads from D365_XREF_CONNECTION_STRING.</summary>
public static class XrefConnection
{
    /// <summary>
    /// Windows authentication yields an ODBC string (the CLI switches to the
    /// msnodesqlv8 driver for it); a SQL login yields a tedious-style string.
    /// </summary>
    public static string Build(ExtensionSettings settings, string? password)
    {
        string server = Required(settings.XrefServer, "SQL Server");
        string database = Required(settings.XrefDatabase, "XRef database");
        string trust = settings.XrefTrustServerCertificate ? "yes" : "no";
        if (settings.XrefAuthentication == XrefAuthentication.Windows)
        {
            string driver = string.IsNullOrWhiteSpace(settings.XrefOdbcDriver) ? "ODBC Driver 17 for SQL Server" : settings.XrefOdbcDriver.Trim();
            return $"Driver={{{driver}}};Server={EscapeOdbc(server)};Database={EscapeOdbc(database)};Trusted_Connection=yes;TrustServerCertificate={trust};";
        }

        string user = Required(settings.XrefUser, "SQL login");
        if (string.IsNullOrEmpty(password))
        {
            throw new ArgumentException("A password is needed for the SQL login.", nameof(password));
        }

        return $"Server={EscapeAdo(server)};Database={EscapeAdo(database)};User Id={EscapeAdo(user)};Password={EscapeAdo(password)};" +
            $"Encrypt=true;TrustServerCertificate={(settings.XrefTrustServerCertificate ? "true" : "false")};";
    }

    /// <summary>ODBC quoting: braces, with '}' doubled.</summary>
    internal static string EscapeOdbc(string value) =>
        value.IndexOfAny(new[] { ';', '{', '}', '=' }) >= 0 || value != value.Trim()
            ? "{" + value.Replace("}", "}}", StringComparison.Ordinal) + "}"
            : value;

    /// <summary>ADO.NET quoting (what the tedious driver parses): double quotes, with '"' doubled.</summary>
    internal static string EscapeAdo(string value) =>
        value.IndexOfAny(new[] { ';', '\'', '"', '=' }) >= 0 || value != value.Trim()
            ? "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\""
            : value;

    private static string Required(string value, string what) =>
        string.IsNullOrWhiteSpace(value) ? throw new ArgumentException($"{what} is not set.") : value.Trim();
}
