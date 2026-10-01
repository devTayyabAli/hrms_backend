import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SendEmailDto, SendTemplateEmailDto, EmailTemplateUtil } from '@app/common';

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private mailEnabled = true;

  constructor(private readonly configService: ConfigService) {}

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
    const fromName = this.configService.get<string>('MAIL_FROM_NAME', 'HRMS Platform');
    const fromEmail = this.configService.get<string>('MAIL_FROM_EMAIL', 'noreply@hrms.local');
    const replyTo = this.configService.get<string>('MAIL_REPLY_TO');
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
    const fromName = this.configService.get<string>('MAIL_FROM_NAME', 'HRMS Platform');
    const rendered = EmailTemplateUtil.renderTemplate(dto.templateName, {
      ...dto.variables,
      fromName,
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
