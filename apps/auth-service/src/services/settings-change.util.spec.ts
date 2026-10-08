import { describeChangedSettings } from './settings-change.util';

describe('describeChangedSettings', () => {
  it('lists only the fields whose value changed, in plain words', () => {
    const before = { require2FASuperAdmins: false, sessionTimeoutMinutes: 30, maxFailedLoginAttempts: 5 };
    expect(
      describeChangedSettings(before, { require2FASuperAdmins: true, sessionTimeoutMinutes: 30, maxFailedLoginAttempts: 3 }),
    ).toBe('Require 2FA super admins, Max failed login attempts');
  });

  it('returns null when nothing changed', () => {
    expect(describeChangedSettings({ platformName: 'HRMS' }, { platformName: 'HRMS', other: undefined })).toBeNull();
  });
});
