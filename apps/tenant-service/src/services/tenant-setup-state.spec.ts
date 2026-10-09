import { TenantProvisioningStatus } from '../models/tenant.model';
import { STALE_SETUP_MS, setupStateOf } from './tenant-setup-state';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const recent = new Date(NOW - 60_000);
const old = new Date(NOW - STALE_SETUP_MS - 1);
const request = (patch: Record<string, unknown> = {}) => ({
  modules: [],
  sendInvitation: true,
  adminName: 'Ayesha',
  adminPhone: null,
  customMessage: null,
  planId: null,
  billingCycle: null,
  completedAt: null,
  lastError: null,
  ...patch,
});

describe('setupStateOf', () => {
  it('is running while this process works on it', () => {
    expect(
      setupStateOf(
        { provisioningStatus: TenantProvisioningStatus.FAILED, updatedAt: old },
        true,
        NOW,
      ).state,
    ).toBe('running');
  });

  it('reports a failed database with the recorded step error first', () => {
    expect(
      setupStateOf(
        {
          provisioningStatus: TenantProvisioningStatus.FAILED,
          provisioningError: 'raw',
          setupRequest: request({ lastError: 'Database: timeout' }),
          updatedAt: recent,
        },
        false,
        NOW,
      ),
    ).toEqual({ state: 'failed', error: 'Database: timeout' });
  });

  it('reports a later step that failed after the database was ready', () => {
    expect(
      setupStateOf(
        {
          provisioningStatus: TenantProvisioningStatus.READY,
          setupRequest: request({ lastError: 'Admin invitation: mail down' }),
          updatedAt: recent,
        },
        false,
        NOW,
      ),
    ).toEqual({ state: 'failed', error: 'Admin invitation: mail down' });
  });

  it('treats an unfinished setup as running until it goes stale', () => {
    const tenant = {
      provisioningStatus: TenantProvisioningStatus.READY,
      setupRequest: request(),
      updatedAt: recent,
    };
    expect(setupStateOf(tenant, false, NOW).state).toBe('running');
    expect(setupStateOf({ ...tenant, updatedAt: old }, false, NOW).state).toBe(
      'failed',
    );
  });

  it('is ready once completed, and for organizations from before setup tracking', () => {
    expect(
      setupStateOf(
        {
          provisioningStatus: TenantProvisioningStatus.READY,
          setupRequest: request({ completedAt: '2026-10-01' }),
          updatedAt: old,
        },
        false,
        NOW,
      ).state,
    ).toBe('ready');
    expect(
      setupStateOf(
        {
          provisioningStatus: TenantProvisioningStatus.READY,
          setupRequest: null,
          updatedAt: old,
        },
        false,
        NOW,
      ).state,
    ).toBe('ready');
  });
});
