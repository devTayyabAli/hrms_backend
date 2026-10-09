import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/sequelize';
import { PlatformSettings } from '../models';
import * as nodemailer from 'nodemailer';
import { SendEmailDto, SendTemplateEmailDto, EmailTemplateUtil } from '@app/common';

interface Branding {
  platformName: string;
  tagline: string | null;
  companyName: string | null;
  supportEmail: string | null;
}

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private mailEnabled = true;

  private brandingCache: { value: Branding; at: number } | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @InjectModel(PlatformSettings) private readonly generalSettings?: typeof PlatformSettings,
  ) {}

  /**
   * System Management › General: the platform's name, tagline, company and
   * support address, which every email carries. Read through a one-minute
   * cache — the env values are the fallback before anything is configured.
   */
  private async branding(): Promise<Branding> {
    if (this.brandingCache && Date.now() - this.brandingCache.at < 60_000) return this.brandingCache.value;
    const fallbackName = this.configService.get<string>('MAIL_FROM_NAME', 'HRMS Platform');
    let value: Branding = { platformName: fallbackName, tagline: null, companyName: null, supportEmail: null };
    try {
      const row = await this.generalSettings?.findOne({
        attributes: ['platformName', 'platformTagline', 'companyName', 'supportEmail'],
      });
      if (row) {
        value = {
          platformName: row.platformName?.trim() || fallbackName,
          tagline: row.platformTagline?.trim() || null,
          companyName: row.companyName?.trim() || null,
          supportEmail: row.supportEmail?.trim() || null,
        };
      }
    } catch (error: any) {
      this.logger.warn(`Email branding unavailable, using defaults: ${error?.message ?? error}`);
    }
    this.brandingCache = { value, at: Date.now() };
    return value;
  }

  async onModuleInit() {
    this.mailEnabled = this.configService.get<string>('MAIL_ENABLED', 'true') === 'true';
    const host = this.configService.get<string>('MAIL_HOST');

    if (!this.mailEnabled || !host) {
      this.logger.warn('MailService initialized in MOCK mode (MAIL_HOST not configured or MAIL_ENABLED=false).');
      return;
    }

    const port = parseInt(this.configService.get<string>('MAIL_PORT', '587'), 10);
    const secure = this.configService.get<string>('MAIL_SECURE', 'false') === 'true';
    const user = this.configService.get<string>('MAIL_USERNAME');
    const pass = this.configService.get<string>('MAIL_PASSWORD');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });

    this.logger.log(`MailService initialized with SMTP host: ${host}:${port}`);
  }

  /**
   * Verify SMTP connection status
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      return false;
    }
    try {
      await this.transporter.verify();
      return true;
    } catch (error: any) {
      this.logger.error(`SMTP connection verification failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Send raw HTML / Text email
   */
  async sendEmail(
    dto: SendEmailDto,
  ): Promise<{ success: boolean; messageId?: string; mocked?: boolean; error?: string }> {
    const brand = await this.branding();
    const fromName = brand.platformName;
    const fromEmail = this.configService.get<string>('MAIL_FROM_EMAIL', 'noreply@hrms.local');
    // Replies reach the support address set in General settings, else the env one.
    const replyTo = brand.supportEmail || this.configService.get<string>('MAIL_REPLY_TO');
    const attachments = dto.attachments?.map((file) => ({
      filename: file.filename,
      content: Buffer.from(file.content, 'base64'),
      contentType: file.contentType,
    }));

    if (!this.transporter || !this.mailEnabled) {
      this.logger.log(
        `[MOCK EMAIL SENT] To: ${dto.to} | Subject: ${dto.subject}${attachments?.length ? ` | ${attachments.length} attachment(s)` : ''}`,
      );
      return { success: true, messageId: `mock-${Date.now()}`, mocked: true };
    }

    try {
      const info = await this.transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to: dto.to,
        subject: dto.subject,
        html: dto.html,
        text: dto.text,
        cc: dto.cc,
        bcc: dto.bcc,
        replyTo: replyTo || undefined,
        attachments,
      });

      this.logger.log(`Email sent successfully to ${dto.to}. MessageId: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error: any) {
      this.logger.error(`Failed to send email to ${dto.to}: ${error.message}`);
      // A short, credential-free reason for whoever retries — the SMTP
      // response code rather than the whole error.
      const reason = error?.responseCode
        ? `Mail server rejected the message (${error.responseCode}).`
        : error?.code === 'ECONNECTION' || error?.code === 'ETIMEDOUT'
          ? 'Could not reach the mail server.'
          : 'The mail server did not accept the message.';
      return { success: false, error: reason };
    }
  }

  /**
   * Send templated email
   */
  async sendTemplateEmail(
    dto: SendTemplateEmailDto,
  ): Promise<{ success: boolean; messageId?: string; mocked?: boolean; error?: string }> {
    const brand = await this.branding();
    const rendered = EmailTemplateUtil.renderTemplate(dto.templateName, {
      ...dto.variables,
      fromName: brand.platformName,
      tagline: brand.tagline,
      companyName: brand.companyName,
      supportEmail: brand.supportEmail,
      subject: dto.subject,
    });

    return this.sendEmail({
      to: dto.to,
      subject: dto.subject,
      html: rendered.html,
      text: rendered.text,
      cc: dto.cc,
      bcc: dto.bcc,
      attachments: dto.attachments,
    });
  }
}
