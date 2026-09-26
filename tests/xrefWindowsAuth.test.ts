import { describe, expect, it } from 'vitest';
import { createMssqlClient, toOdbcConnectionString, usesWindowsAuthentication } from '../src/indexer/xrefSql.js';

describe('index-xref Windows authentication', () => {
  it('recognises integrated-security connection strings', () => {
    expect(usesWindowsAuthentication('Server=.;Database=DYNAMICSXREFDB;Trusted_Connection=yes')).toBe(true);
    expect(usesWindowsAuthentication('Server=.;Integrated Security=SSPI;Database=X')).toBe(true);
    expect(usesWindowsAuthentication('Server=.;Database=X;User Id=u;Password=p')).toBe(false);
    expect(usesWindowsAuthentication('Server=.;Trusted_Connection=no')).toBe(false);
  });

  it('builds an ODBC connection string with a default driver', () => {
    expect(toOdbcConnectionString('Server=localhost;Database=DYNAMICSXREFDB;Integrated Security=SSPI')).toBe(
      'Driver={ODBC Driver 17 for SQL Server};Server=localhost;Database=DYNAMICSXREFDB;Trusted_Connection=yes;'
    );
    expect(toOdbcConnectionString('Driver={ODBC Driver 18 for SQL Server};Server=.;Trusted_Connection=yes;')).toBe(
      'Driver={ODBC Driver 18 for SQL Server};Server=.;Trusted_Connection=yes;'
    );
  });

  it('explains how to get the native driver when it is missing', async () => {
    // msnodesqlv8 is never installed in this repository's dependencies.
    await expect(createMssqlClient('Server=localhost;Database=DYNAMICSXREFDB;Trusted_Connection=yes'))
      .rejects.toThrow(/msnodesqlv8/);
  });
});
