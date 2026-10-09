import {
  diffChanges,
  displayValue,
  humanizeField,
} from './audit-trail.interceptor';

describe('audit trail helpers', () => {
  it('names fields the way people read them', () => {
    expect(humanizeField('sessionIdleTimeoutMinutes')).toBe(
      'Session idle timeout minutes',
    );
    expect(humanizeField('require2FASuperAdmins')).toBe(
      'Require 2FA super admins',
    );
    expect(humanizeField('ipWhitelistEnabled')).toBe('Ip whitelist enabled');
    expect(humanizeField('allowedIPs')).toBe('Allowed IPs');
    expect(humanizeField('platform_name')).toBe('Platform name');
  });

  it('shows values plainly', () => {
    expect(displayValue(true)).toBe('On');
    expect(displayValue(false)).toBe('Off');
    expect(displayValue(null)).toBe('—');
    expect(displayValue(['a', 'b'])).toBe('a, b');
  });

  it('records only the fields that actually changed, with old and new values', () => {
    const before = {
      platformName: 'Fuutura',
      supportEmail: 'a@x.com',
      allowUsersToExportData: true,
    };
    const body = {
      platformName: 'Fuutura',
      supportEmail: 'help@x.com',
      allowUsersToExportData: false,
    };
    expect(diffChanges(before, body)).toEqual([
      { field: 'Support email', before: 'a@x.com', after: 'help@x.com' },
      { field: 'Allow users to export data', before: 'On', after: 'Off' },
    ]);
  });

  it('never records secrets or fields the record does not have', () => {
    expect(
      diffChanges({ password: 'old' }, { password: 'new', unknown: 1 }),
    ).toEqual([]);
    expect(diffChanges(undefined, { a: 1 })).toEqual([]);
  });
});
