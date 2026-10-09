import { Injectable, Logger, Optional } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { TenantService } from './tenant.service';
import { TenantDatabaseConfigService } from './tenant-database-config.service';
import { OrganizationModuleAccessService } from './organization-module-access.service';
import {
  OrganizationAdminInvitationService,
  AdminInvitationResult,
} from './organization-admin-invitation.service';
import { PlatformBillingService } from './platform-billing.service';
import { DirectoryProjectionService } from './directory-projection.service';
import { PlatformNotifierService } from './platform-notifier.service';
import {
  BaseTenantModelProvider,
  TenantConnectionManager,
} from '@app/tenant-context';
import { bindModelsToConnection, resolveDbCredentials } from '@app/database';
import { TENANT_OPERATIONAL_MODELS } from './tenant-model-provider.service';
import {
  TenantProvisioningStatus,
  TenantStatus,
  TenantSetupStatus,
  TenantSetupRequest,
} from '../models/tenant.model';
import { setupStateOf } from './tenant-setup-state';
import {
  TenantException,
  TenantErrorCode,
  CreateOrganizationOnboardingDto,
  ConfigureModuleAccessDto,
  BillingCycle,
  SubscriptionStatus,
} from '@app/common';

/** Where a background organization creation has got to. */
export interface OrganizationCreationStatus {
  tenantId: string;
  state: 'running' | 'done' | 'failed';
  result?: OrganizationCreationResult;
  error?: string;
}

/**
 * A draft left PROVISIONING this long was abandoned — the process creating it
 * restarted — and may be cleaned up so the name can be used again.
 */
const STALE_PROVISIONING_MS = 15 * 60 * 1000;

export interface OrganizationCreationResult {
  tenantId: string;
  organizationName: string;
  slug: string;
  databaseName: string;
  status: TenantStatus;
  provisioningStatus: TenantProvisioningStatus;
  setupStatus: TenantSetupStatus;
  invitation?: AdminInvitationResult;
  subscription?: any;
  message: string;
}

@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);
  /**
   * Creations still running or recently finished, by tenant id. Memory is
   * enough: after a restart the tenant row's provisioning status answers.
   */
  private readonly creations = new Map<string, OrganizationCreationStatus>();

  constructor(
    private tenantService: TenantService,
    private tenantDbConfigService: TenantDatabaseConfigService,
    private tenantConnectionManager: TenantConnectionManager,
    private moduleAccessService: OrganizationModuleAccessService,
    private invitationService: OrganizationAdminInvitationService,
    private billingService: PlatformBillingService,
    private directoryProjection: DirectoryProjectionService,
    @Optional() private platformNotifier?: PlatformNotifierService,
  ) {}

  /**
   * Safe generator for PostgreSQL database names (Phase E)
   * Pattern: hrms_<sanitized_tenant_identifier>
   */
  public generateDatabaseName(tenantId: string): string {
    const safeIdentifier = tenantId
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .toLowerCase();
    return `hrms_${safeIdentifier}`;
  }

  /**
   * Safe generator for unique Organization Slugs (Phase D)
   */
  public generateSlug(organizationName: string, domain?: string): string {
    const base = domain || organizationName;
    return base
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Starts creating an organization and returns as soon as its tenant row
   * exists. Provisioning the database (a full schema sync — well over a
   * minute against a remote Postgres), module access, the invitation and the
   * subscription carry on in the background; poll `getCreationStatus`.
   *
   * Done in one request it outlived the reverse proxy's 60s timeout: the
   * caller got a 504 while the organization was still created, and retrying
   * then failed on "already exists".
   */
  async startOrganizationCreation(
    data: any,
  ): Promise<OrganizationCreationResult> {
    let started!: (tenant: any) => void;
    const tenantCreated = new Promise<any>((resolve) => (started = resolve));

    const run = this.createOrganizationAndProvision(data, started);
    // Validation and duplicate-name errors happen before the tenant exists,
    // so they still reach the caller as an ordinary failed request.
    const first = await Promise.race([tenantCreated, run.then(() => null)]);
    const tenant = first ?? (await tenantCreated);

    this.creations.set(tenant.id, { tenantId: tenant.id, state: 'running' });
    const orgName = tenant.organizationName || tenant.name;
    run.then(
      (result) => {
        this.finishCreation(tenant.id, {
          tenantId: tenant.id,
          state: 'done',
          result,
        });
        this.platformNotifier?.account(
          `Organization created: ${orgName}`,
          result.invitation
            ? `Its database is ready and an activation invitation was sent to ${result.invitation.adminEmail}.`
            : 'Its database is ready. No admin invitation was sent.',
        );
      },
      (error: any) => {
        this.logger.error(
          `Creating organization ${tenant.id} failed: ${error?.message ?? error}`,
        );
        this.finishCreation(tenant.id, {
          tenantId: tenant.id,
          state: 'failed',
          error: error?.message || 'Organization creation failed.',
        });
        this.platformNotifier?.account(
          `Organization setup failed: ${orgName}`,
          `Provisioning stopped with: ${error?.message || 'an unknown error'}. Creating it again with the same name will retry.`,
        );
      },
    );

    return {
      tenantId: tenant.id,
      organizationName: tenant.organizationName || tenant.name,
      slug: tenant.slug,
      databaseName: this.generateDatabaseName(tenant.id),
      status: tenant.status,
      provisioningStatus: TenantProvisioningStatus.PROVISIONING,
      setupStatus: tenant.setupStatus,
      message: `Organization '${tenant.organizationName || tenant.name}' is being created.`,
    };
  }

  /** Kept for an hour so a slow poller still sees the outcome, then dropped. */
  private finishCreation(tenantId: string, status: OrganizationCreationStatus) {
    this.creations.set(tenantId, status);
    setTimeout(() => this.creations.delete(tenantId), 60 * 60 * 1000).unref?.();
  }

  async getCreationStatus(
    tenantId: string,
  ): Promise<OrganizationCreationStatus> {
    const known = this.creations.get(tenantId);
    if (known) return known;

    // Not created by this process (or it restarted): read the tenant row.
    const tenant = await this.tenantService.getTenantById(tenantId);
    const setup = setupStateOf(tenant, false);
    if (setup.state === 'failed') {
      return {
        tenantId,
        state: 'failed',
        error: setup.error || 'Organization setup failed.',
      };
    }
    if (setup.state === 'ready') {
      return {
        tenantId,
        state: 'done',
        result: {
          tenantId,
          organizationName: tenant.organizationName || tenant.name,
          slug: tenant.slug || tenant.domain,
          databaseName: this.generateDatabaseName(tenantId),
          status: tenant.status,
          provisioningStatus: tenant.provisioningStatus,
          setupStatus: tenant.setupStatus,
          message: `Organization '${tenant.organizationName || tenant.name}' created.`,
        },
      };
    }
    return { tenantId, state: 'running' };
  }

  /**
   * Full Organization Creation & Tenant DB Provisioning Flow (Steps 1-4).
   * `onTenantCreated` fires once the tenant row exists, before provisioning.
   */
  async createOrganizationAndProvision(
    data: any,
    onTenantCreated?: (tenant: any) => void,
  ): Promise<OrganizationCreationResult> {
    const org = data.organizationInfo || data;
    const admin = data.adminInfo || data;

    const orgName = org.organizationName || data.organizationName || data.name;
    const legalName = org.legalName || data.legalName || orgName;
    const businessEmail =
      org.businessEmail || data.businessEmail || data.officialEmail;
    const adminEmail =
      admin.adminEmail ||
      data.adminEmail ||
      data.adminDetails?.workEmail ||
      businessEmail;
    const adminName =
      admin.adminName ||
      data.adminName ||
      (data.adminDetails
        ? `${data.adminDetails.firstName} ${data.adminDetails.lastName}`.trim()
        : 'Admin');
    const firstName =
      data.adminDetails?.firstName ||
      (adminName ? adminName.split(' ')[0] : 'Admin');
    const lastName =
      data.adminDetails?.lastName ||
      (adminName ? adminName.split(' ').slice(1).join(' ') : '');
    const fullAdminName =
      adminName || `${firstName} ${lastName}`.trim() || 'Admin';
    const domain = org.domain || data.domain;
    const industry =
      org.industry || data.industry || data.adminDetails?.industry;
    const phone = org.phone || data.phone || data.adminDetails?.phone;
    const adminPhone = admin.adminPhone || data.adminPhone || phone;
    const country = org.country || data.country;
    const companySize = org.companySize || data.companySize;
    const profilePhoto = admin.profilePhoto || data.profilePhoto;
    // The organization's own mark, which is not the admin's photo — the two
    // used to share `logoUrl` and overwrite each other.
    const organizationLogo = org.logoUrl || data.logoUrl || null;
    // Every admin created through this flow is the organization's admin; the
    // wizard collects no job title, so the role itself is the designation.
    const adminDesignation =
      admin.adminDesignation || data.adminDesignation || 'Organization Admin';
    const sendInvitation =
      admin.sendInvitation !== false && data.sendInvitation !== false;
    const customInvitationMessage =
      admin.customMessage ||
      data.customMessage ||
      data.adminDetails?.customInvitationMessage ||
      data.customInvitationMessage;
    const planId = data.planId;
    const billingCycle = data.billingCycle || BillingCycle.MONTHLY;

    // Validate Plan if planId is provided
    if (planId) {
      const plan = await this.billingService.getPlanById(planId);
      if (!plan.isActive) {
        throw new TenantException(
          TenantErrorCode.PLAN_INACTIVE,
          `Selected plan '${plan.name}' is inactive and cannot be chosen for new subscription.`,
        );
      }
    }

    const slug = data.slug || org.slug || this.generateSlug(orgName, domain);

    // Check duplicate organization slug
    const existing = await this.tenantService.getTenantByDomainOrSlug(slug);
    if (existing) {
      const abandoned =
        existing.provisioningStatus === TenantProvisioningStatus.FAILED ||
        (existing.provisioningStatus !== TenantProvisioningStatus.READY &&
          !this.creations.has(existing.id) &&
          Date.now() - new Date(existing.updatedAt).getTime() >
            STALE_PROVISIONING_MS);
      if (existing.status === TenantStatus.DRAFT && abandoned) {
        this.logger.warn(
          `Found previously failed draft tenant ${existing.id} with slug '${slug}'. Cleaning up before retrying creation.`,
        );
        const failedDbName = this.generateDatabaseName(existing.id);
        await this.tenantDbConfigService
          .deleteTenantDatabaseConfig(existing.id)
          .catch(() => {});
        await existing.destroy();
        await this.dropTenantDatabase(failedDbName).catch(() => {});
      } else {
        throw new TenantException(
          TenantErrorCode.INVALID_TENANT_CONTEXT,
          this.creations.get(existing.id)?.state === 'running'
            ? `Organization '${slug}' is already being created. Please wait for it to finish.`
            : `An organization with the name or domain '${slug}' already exists. If its setup failed, use “Retry setup” on the Organizations page.`,
        );
      }
    }

    // Step 1: Create Tenant Record in DRAFT status
    const tenant = await this.tenantService.createTenant({
      name: orgName,
      organizationName: orgName,
      legalName,
      companySize,
      officialEmail: businessEmail || adminEmail,
      logoUrl: organizationLogo,
      slug,
      domain: domain || slug,
      email: businessEmail || adminEmail,
      adminEmail: adminEmail,
      adminDesignation,
      adminAvatarUrl: profilePhoto || null,
      industry: industry || null,
      phone: phone || null,
      country: country || null,
      state: data.state || null,
      city: data.city || null,
      address: data.address || null,
      timezone: data.timezone || null,
      currency: data.currency || null,
      planType: data.planType || 'standard',
      status: TenantStatus.DRAFT,
      setupStatus: TenantSetupStatus.NOT_STARTED,
      provisioningStatus: TenantProvisioningStatus.PENDING,
      isActive: true,
    });

    // Kept on the tenant so a failed setup can be retried to completion, and so
    // a first invitation sent later still has the admin's name.
    const modules: ConfigureModuleAccessDto[] = data.modules || [];
    const setupRequest: TenantSetupRequest = {
      modules: modules.map((m) => ({
        moduleKey: m.moduleKey,
        enabled: m.enabled,
        allowedActions: m.allowedActions,
      })),
      sendInvitation,
      adminName: fullAdminName || null,
      adminPhone: adminPhone || null,
      customMessage: customInvitationMessage || null,
      planId: planId || null,
      billingCycle: billingCycle || null,
      completedAt: null,
      lastError: null,
    };
    await tenant.update({ setupRequest });
    onTenantCreated?.(tenant);

    return this.completeSetup(tenant.id);
  }

  /**
   * Runs every setup step that hasn't finished yet: the database, module
   * access, the admin invitation (if one was asked for and none was sent) and
   * the subscription. Each step is safe to repeat, so a retry simply picks up
   * where the last attempt stopped. A failure is recorded on the tenant.
   */
  private async completeSetup(
    tenantId: string,
  ): Promise<OrganizationCreationResult> {
    let tenant = await this.tenantService.getTenantById(tenantId);
    const request: TenantSetupRequest = tenant.setupRequest ?? {
      modules: [],
      sendInvitation: false,
      adminName: null,
      adminPhone: null,
      customMessage: null,
      planId: null,
      billingCycle: null,
      completedAt: null,
      lastError: null,
    };
    const orgName = tenant.organizationName || tenant.name;

    const step = async <T>(
      label: string,
      run: () => Promise<T>,
    ): Promise<T> => {
      try {
        return await run();
      } catch (error: any) {
        const message = String(
          error?.message || error || 'Unknown error',
        ).replace(/^Organization database provisioning failed: /, '');
        await this.patchSetupRequest(tenantId, {
          lastError: `${label}: ${message}`,
        });
        throw error;
      }
    };

    // Step 1: the isolated database (skipped once it is READY).
    const provisioningResult =
      tenant.provisioningStatus === TenantProvisioningStatus.READY
        ? null
        : await step('Database', () =>
            this.provisionTenantDatabase(
              tenant.id,
              this.generateDatabaseName(tenant.id),
              orgName,
              tenant.slug,
            ),
          );

    // Step 2: module access.
    if (request.modules.length) {
      await step('Module access', () =>
        this.moduleAccessService.setOrganizationModules(
          tenant.id,
          request.modules as ConfigureModuleAccessDto[],
        ),
      );
    }

    // Step 3: the admin invitation — only if asked for and not already sent.
    let invitationResult: AdminInvitationResult | undefined;
    if (
      request.sendInvitation &&
      !(await this.invitationService.hasInvitation(tenant.id))
    ) {
      invitationResult = await step('Admin invitation', () =>
        this.invitationService.createAdminInvitation(
          tenant.id,
          tenant.adminEmail,
          request.adminName ?? undefined,
          'SuperAdmin',
          request.adminPhone ?? undefined,
          request.customMessage ?? undefined,
        ),
      );
    }

    // Step 4: the initial subscription, if a plan was chosen and none exists.
    let subscription: any = undefined;
    if (
      request.planId &&
      !(await this.billingService.getSubscriptionByTenant(tenant.id))
    ) {
      subscription = await step('Subscription', () =>
        this.billingService.createSubscription(
          tenant.id,
          request.planId!,
          (request.billingCycle as BillingCycle) || BillingCycle.MONTHLY,
          SubscriptionStatus.PENDING_PAYMENT,
        ),
      );
    }

    await this.patchSetupRequest(tenantId, {
      completedAt: new Date().toISOString(),
      lastError: null,
    });
    tenant = await this.tenantService.getTenantById(tenantId);

    return {
      tenantId: tenant.id,
      organizationName: orgName,
      slug: tenant.slug || tenant.domain,
      databaseName:
        provisioningResult?.databaseName ??
        this.generateDatabaseName(tenant.id),
      status: tenant.status,
      provisioningStatus: tenant.provisioningStatus,
      setupStatus: tenant.setupStatus,
      invitation: invitationResult,
      subscription,
      message: `Organization '${orgName}' is set up. Status: ${tenant.status}.`,
    };
  }

  /** Merges into the stored setup request without overwriting the rest of it. */
  private async patchSetupRequest(
    tenantId: string,
    patch: Partial<TenantSetupRequest>,
  ) {
    const tenant = await this.tenantService.getTenantById(tenantId);
    const current = tenant.setupRequest;
    // Organizations created before this existed have none; record the outcome anyway.
    await tenant.update({
      setupRequest: {
        modules: [],
        sendInvitation: false,
        adminName: null,
        adminPhone: null,
        customMessage: null,
        planId: null,
        billingCycle: null,
        completedAt: null,
        lastError: null,
        ...(current ?? {}),
        ...patch,
      },
    });
  }

  /** Whether a creation or retry is running in this process right now. */
  isSetupRunning(tenantId: string): boolean {
    return this.creations.get(tenantId)?.state === 'running';
  }

  /**
   * Idempotent Database Provisioning Core (Phase F, G, H, I, J)
   */
  async provisionTenantDatabase(
    tenantId: string,
    customDbName?: string,
    organizationName?: string,
    slug?: string,
  ): Promise<OrganizationCreationResult> {
    const tenant = await this.tenantService.getTenantById(tenantId);
    const databaseName = customDbName || this.generateDatabaseName(tenant.id);

    // Update status to PROVISIONING
    await tenant.update({
      provisioningStatus: TenantProvisioningStatus.PROVISIONING,
      provisioningError: null,
    });

    try {
      // Step A: Check if database exists idempotently
      const dbExists = await this.checkDatabaseExists(databaseName);
      if (!dbExists) {
        await this.createTenantDatabase(databaseName);
      } else {
        this.logger.log(
          `Database '${databaseName}' already exists. Skipping SQL CREATE DATABASE.`,
        );
      }

      // Step B: Initialize Base Schema & Migrations idempotently (Phase I)
      await this.runMigrationsAndBaseSchema(databaseName);
      BaseTenantModelProvider.markTenantSynced(tenant.id);

      // Step C: Save / Update TenantDatabaseConfig (Phase H)
      const tenantCreds = resolveDbCredentials('tenant');
      await this.tenantDbConfigService.saveOrUpdateTenantDatabaseConfig(
        tenant.id,
        databaseName,
        tenantCreds.host,
        tenantCreds.port,
        tenantCreds.username,
        tenantCreds.password,
      );

      // Step D: Mark Provisioning as READY & set status to PENDING_ADMIN_ACTIVATION
      await tenant.update({
        provisioningStatus: TenantProvisioningStatus.READY,
        status: TenantStatus.PENDING_ADMIN_ACTIVATION,
        setupStatus: TenantSetupStatus.NOT_STARTED,
      });

      this.logger.log(
        `Tenant ${tenant.id} (${databaseName}) database provisioned successfully. Status: PENDING_ADMIN_ACTIVATION.`,
      );

      return {
        tenantId: tenant.id,
        organizationName: tenant.organizationName || tenant.name,
        slug: tenant.slug || slug || tenant.domain,
        databaseName,
        status: TenantStatus.PENDING_ADMIN_ACTIVATION,
        provisioningStatus: TenantProvisioningStatus.READY,
        setupStatus: TenantSetupStatus.NOT_STARTED,
        message: `Organization database '${databaseName}' provisioned and initialized successfully. Pending Admin Activation.`,
      };
    } catch (error: any) {
      const safeErrorMessage =
        error.message || 'Unknown database provisioning error';
      this.logger.error(
        `Provisioning failed for tenant ${tenant.id}: ${safeErrorMessage}`,
      );

      // Failure Handling (Phase J): Mark FAILED and store safe error metadata
      await tenant.update({
        provisioningStatus: TenantProvisioningStatus.FAILED,
        provisioningError: safeErrorMessage,
      });

      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Organization database provisioning failed: ${safeErrorMessage}`,
      );
    }
  }

  /**
   * Retries a failed (or abandoned) setup in the background and returns at
   * once; follow it with `getCreationStatus`, like a new creation. Picks up at
   * the step that failed — the database, module access, the invitation or the
   * subscription.
   */
  async retryProvisioning(
    tenantId: string,
  ): Promise<OrganizationCreationStatus> {
    const tenant = await this.tenantService.getTenantById(tenantId);
    if (this.isSetupRunning(tenantId)) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'This organization is already being set up. Please wait for it to finish.',
      );
    }
    if (setupStateOf(tenant, false).state === 'ready') {
      return { tenantId, state: 'done' };
    }

    this.logger.log(`Retrying setup for tenant ${tenantId}...`);
    await this.patchSetupRequest(tenantId, { lastError: null });
    this.creations.set(tenantId, { tenantId, state: 'running' });
    const orgName = tenant.organizationName || tenant.name;

    this.completeSetup(tenantId).then(
      (result) => {
        this.finishCreation(tenantId, { tenantId, state: 'done', result });
        this.platformNotifier?.account(
          `Organization setup completed: ${orgName}`,
          result.invitation
            ? `An activation invitation was sent to ${result.invitation.adminEmail}.`
            : 'Every setup step has now finished.',
        );
      },
      (error: any) => {
        this.logger.error(
          `Retrying setup of ${tenantId} failed: ${error?.message ?? error}`,
        );
        this.finishCreation(tenantId, {
          tenantId,
          state: 'failed',
          error: error?.message || 'Setup failed again.',
        });
        this.platformNotifier?.account(
          `Organization setup failed again: ${orgName}`,
          error?.message || 'An unknown error stopped it.',
        );
      },
    );

    return { tenantId, state: 'running' };
  }

  /**
   * PostgreSQL identifiers (database/table names) can't be bound as query
   * parameters — Sequelize/pg only parameterize VALUES, not identifiers —
   * so CREATE/DROP DATABASE below can't rely on `replacements`. This
   * allow-list check is the actual injection defense for those statements,
   * enforced right at the point of use rather than just assumed from
   * caller behavior (generateDatabaseName() already produces only this
   * shape, but a future caller passing a raw/unsanitized name must not be
   * able to reach a raw DDL statement).
   */
  private assertSafeDatabaseIdentifier(databaseName: string): void {
    if (!/^[a-z0-9_]+$/.test(databaseName)) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Refusing to run DDL against an unsafe database identifier: "${databaseName}"`,
      );
    }
  }

  /**
   * Check if PostgreSQL database exists idempotently
   */
  private async checkDatabaseExists(databaseName: string): Promise<boolean> {
    const sequelize = this.getPlatformMasterSequelize();
    try {
      // eslint-disable-next-line no-restricted-syntax -- checking pg_database has no model; value is bound via `replacements`, never interpolated.
      const [results]: any = await sequelize.query(
        `SELECT 1 FROM pg_database WHERE datname = :databaseName;`,
        { replacements: { databaseName } },
      );
      return results && results.length > 0;
    } catch {
      return false;
    } finally {
      await sequelize.close();
    }
  }

  /**
   * Create PostgreSQL database safely
   */
  private async createTenantDatabase(databaseName: string): Promise<void> {
    this.assertSafeDatabaseIdentifier(databaseName);
    const sequelize = this.getPlatformMasterSequelize();
    try {
      // eslint-disable-next-line no-restricted-syntax -- CREATE DATABASE has no model equivalent; identifier can't be bound as a parameter, so it's validated by assertSafeDatabaseIdentifier() above instead.
      await sequelize.query(`CREATE DATABASE "${databaseName}";`);
      this.logger.log(`Database "${databaseName}" created successfully.`);
    } catch (error: any) {
      if (error.message && error.message.includes('already exists')) {
        return;
      }
      throw error;
    } finally {
      await sequelize.close();
    }
  }

  /**
   * Run Base Tenant Schema Initialization & Migrations (Phase I)
   */
  private async runMigrationsAndBaseSchema(
    databaseName: string,
  ): Promise<void> {
    const creds = resolveDbCredentials('tenant');
    const sequelize = new Sequelize({
      host: creds.host,
      port: creds.port,
      username: creds.username,
      password: creds.password,
      database: databaseName,
      dialect: 'postgres',
      dialectOptions: creds.dialectOptions,
      logging: false,
    });

    try {
      await sequelize.authenticate();
      // Initialize base schema tracking table
      // eslint-disable-next-line no-restricted-syntax -- one-time bootstrap DDL, no dynamic/untrusted values interpolated.
      await sequelize.query(`
        CREATE TABLE IF NOT EXISTS tenant_schema_migrations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          version VARCHAR(50) NOT NULL UNIQUE,
          executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Record base migration version 1.0.0
      // eslint-disable-next-line no-restricted-syntax -- static literal, no dynamic/untrusted values interpolated.
      await sequelize.query(`
        INSERT INTO tenant_schema_migrations (version)
        VALUES ('1.0.0')
        ON CONFLICT (version) DO NOTHING;
      `);

      // Bind tenant operational models to this connection before schema sync
      bindModelsToConnection(TENANT_OPERATIONAL_MODELS, sequelize);

      // Sync base tables idempotently
      await sequelize.sync({ force: false });

      // Ensure designation code index is scoped per department, not globally
      // eslint-disable-next-line no-restricted-syntax -- static DDL for index schema fix
      await sequelize.query(`DROP INDEX IF EXISTS "unique_designation_code";`);
      // eslint-disable-next-line no-restricted-syntax -- static DDL for index schema fix
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "unique_designation_code_per_department" ON "designations" ("tenantId", "departmentId", "code");`,
      );
    } catch (error: any) {
      this.logger.error(
        `Base schema initialization failed for database ${databaseName}: ${error.message}`,
      );
      throw error;
    } finally {
      await sequelize.close();
    }
  }

  /**
   * Deprovision tenant safely
   */
  async deprovisionTenant(tenantId: string): Promise<void> {
    const dbConfig =
      await this.tenantDbConfigService.getTenantDatabaseConfig(tenantId);
    try {
      await this.tenantConnectionManager.closeConnection(tenantId);
      await this.dropTenantDatabase(dbConfig.databaseName);
      await this.tenantDbConfigService.deleteTenantDatabaseConfig(tenantId);
      await this.tenantService.deleteTenant(tenantId);

      // The SuperAdmin directory is a copy of data that has just ceased to
      // exist. Nothing else removes it: the relay only visits tenants that
      // are still listed, so without this the deprovisioned organization's
      // people stay on the Clients screen forever.
      await this.directoryProjection.dropTenant(tenantId);

      this.logger.log(`Tenant ${tenantId} deprovisioned cleanly.`);
    } catch (error: any) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Failed to deprovision tenant: ${error.message}`,
      );
    }
  }

  private async dropTenantDatabase(databaseName: string): Promise<void> {
    this.assertSafeDatabaseIdentifier(databaseName);
    const sequelize = this.getPlatformMasterSequelize();
    try {
      // eslint-disable-next-line no-restricted-syntax -- pg_stat_activity has no model; value is bound via `replacements`, never interpolated.
      await sequelize.query(
        `SELECT pg_terminate_backend(pg_stat_activity.pid)
         FROM pg_stat_activity
         WHERE pg_stat_activity.datname = :databaseName
         AND pid <> pg_backend_pid();`,
        { replacements: { databaseName } },
      );
      // eslint-disable-next-line no-restricted-syntax -- DROP DATABASE has no model equivalent; identifier can't be bound as a parameter, so it's validated by assertSafeDatabaseIdentifier() above instead.
      await sequelize.query(`DROP DATABASE IF EXISTS "${databaseName}";`);
    } finally {
      await sequelize.close();
    }
  }

  private getPlatformMasterSequelize(): Sequelize {
    // Connects to the platform database (PLATFORM_DB_NAME), so it must use
    // PLATFORM_DB_* credentials — this previously (incorrectly) used
    // TENANT_DB_* here, which only worked by coincidence in deployments
    // where both happen to share the same credentials.
    const creds = resolveDbCredentials('platform');
    return new Sequelize({
      host: creds.host,
      port: creds.port,
      username: creds.username,
      password: creds.password,
      database: process.env.PLATFORM_DB_NAME || 'neondb',
      dialect: 'postgres',
      dialectOptions: creds.dialectOptions,
      logging: false,
    });
  }
}
