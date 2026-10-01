export class EmailTemplateUtil {
  /**
   * Render HTML email template with dynamic variable substitution
   */
  public static renderTemplate(
    templateName: string,
    variables: Record<string, any>,
  ): { html: string; text: string } {
    const year = new Date().getFullYear();
    const fromName = variables.fromName || 'HRMS Platform';

    let contentHtml = '';
    let textFallback = '';

    switch (templateName) {
      case 'otp_email':
        contentHtml = `
          <h2 style="color: #1e293b; margin-top: 0;">Verification / Security Code</h2>
          <p>Hello ${variables.firstName || 'User'},</p>
          <p>You requested a verification code for your HRMS account (${variables.organizationName || 'HRMS System'}).</p>
          <div style="background-color: #f1f5f9; border-radius: 8px; padding: 20px; text-align: center; margin: 25px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #2563eb;">${variables.otp || '000000'}</span>
          </div>
          <p style="color: #64748b; font-size: 14px;">This code expires in 10 minutes. If you did not request this code, please ignore this email.</p>
        `;
        textFallback = `Hello ${variables.firstName || 'User'},\n\nYour HRMS verification code is: ${variables.otp || '000000'}.\nIt expires in 10 minutes.`;
        break;

      case 'password_changed':
        contentHtml = `
          <h2 style="color: #1e293b; margin-top: 0;">Password Changed Notice</h2>
          <p>Hello ${variables.firstName || 'User'},</p>
          <p>This is confirmation that the password for your account <strong>${variables.email || ''}</strong> was changed on ${new Date().toLocaleString()}.</p>
          <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0;">
            <p style="margin: 0; color: #991b1b; font-size: 14px;">If you did not perform this password change, please contact support immediately to secure your account.</p>
          </div>
        `;
        textFallback = `Hello ${variables.firstName || 'User'},\n\nYour HRMS account password was changed successfully.\nIf you did not make this change, please contact support immediately.`;
        break;

      case 'security_alert':
        contentHtml = `
          <h2 style="color: #dc2626; margin-top: 0;">New Login Security Alert</h2>
          <p>Hello ${variables.firstName || 'User'},</p>
          <p>A new login was detected on your HRMS SuperAdmin account:</p>
          <ul style="color: #334155; line-height: 1.6;">
            <li><strong>IP Address:</strong> ${variables.ipAddress || 'Unknown'}</li>
            <li><strong>Location:</strong> ${variables.location || 'Unknown Location'}</li>
            <li><strong>Time:</strong> ${variables.timestamp || new Date().toISOString()}</li>
            <li><strong>Device/Browser:</strong> ${variables.device || 'Unknown Device'}</li>
          </ul>
          <p style="color: #64748b; font-size: 14px;">If this was you, no action is required.</p>
        `;
        textFallback = `Security Alert: New login detected on your HRMS account from IP ${variables.ipAddress || 'Unknown'} at ${variables.timestamp || new Date().toISOString()}.`;
        break;

      case 'admin_invitation':
      case 'user_invitation':
        contentHtml = `
          <h2 style="color: #2563eb; margin-top: 0;">Invitation to Join ${variables.organizationName || 'HRMS Organization'}</h2>
          <p>Hello ${variables.firstName || 'User'},</p>
          <p>You have been invited to join <strong>${variables.organizationName || 'HRMS Platform'}</strong> as ${variables.roleName || 'an Administrator'}.</p>
          ${variables.customMessage ? `<div style="background-color: #f8fafc; border-left: 4px solid #2563eb; padding: 12px 16px; margin: 18px 0; border-radius: 4px;"><p style="margin: 0; color: #475569; font-style: italic;">"${variables.customMessage}"</p></div>` : ''}
          <div style="text-align: center; margin: 30px 0;">
            <a href="${variables.invitationLink || '#'}" style="background-color: #2563eb; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Accept Invitation & Setup Account</a>
          </div>
          <p style="color: #64748b; font-size: 13px;">This invitation link will expire on <strong>${variables.expiresAt || '7 days'}</strong>.</p>
        `;
        textFallback = `Hello ${variables.firstName || 'User'},\n\nYou are invited to join ${variables.organizationName || 'HRMS'} as ${variables.roleName || 'an Administrator'}.${variables.customMessage ? `\nMessage: "${variables.customMessage}"` : ''}\nClick link to accept: ${variables.invitationLink || '#'}`;
        break;

      // The breakdown lives in the attached PDF — the body carries only
      // what the reader needs to recognise it.
      case 'payslip': {
        const esc = (value: unknown) =>
          String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
        contentHtml = `
          <h2 style="color: #1e293b; margin-top: 0;">Your payslip for ${esc(variables.periodLabel)}</h2>
          <p>Hello ${esc(variables.firstName || 'there')},</p>
          <p>Your payslip from <strong>${esc(variables.organizationName || 'your organization')}</strong> for ${esc(variables.periodLabel)} is attached as a PDF.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
            <tr><td style="padding: 8px 0; color: #64748b;">Net pay</td><td style="padding: 8px 0; text-align: right; font-weight: bold; color: #0f172a;">${esc(variables.netPay)}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b; border-top: 1px solid #e2e8f0;">Paid on</td><td style="padding: 8px 0; text-align: right; border-top: 1px solid #e2e8f0;">${esc(variables.paymentDate)}</td></tr>
            <tr><td style="padding: 8px 0; color: #64748b; border-top: 1px solid #e2e8f0;">Payslip no.</td><td style="padding: 8px 0; text-align: right; border-top: 1px solid #e2e8f0;">${esc(variables.payslipNumber)}</td></tr>
          </table>
          <p style="color: #64748b; font-size: 13px;">You can also view and download your payslips any time under My Payslips in the employee portal. If anything looks wrong, please contact HR.</p>
        `;
        textFallback = `Hello ${variables.firstName || 'there'},\n\nYour payslip from ${variables.organizationName || 'your organization'} for ${variables.periodLabel} is attached.\nNet pay: ${variables.netPay}\nPaid on: ${variables.paymentDate}\nPayslip no.: ${variables.payslipNumber}\n\nIf anything looks wrong, please contact HR.`;
        break;
      }

      case 'welcome_email':
        contentHtml = `
          <h2 style="color: #1e293b; margin-top: 0;">Welcome to ${variables.organizationName || 'HRMS Platform'}!</h2>
          <p>Hello ${variables.firstName || 'User'},</p>
          <p>Your account is now activated and ready for action.</p>
        `;
        textFallback = `Welcome to HRMS! Your account is active.`;
        break;

      default:
        contentHtml = `
          <h2 style="color: #1e293b; margin-top: 0;">${variables.title || 'System Notification'}</h2>
          <p>${variables.message || ''}</p>
        `;
        textFallback = `${variables.title || 'Notification'}: ${variables.message || ''}`;
        break;
    }

    const fullHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>${variables.subject || 'HRMS Notification'}</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 40px 20px;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
          <div style="border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 24px;">
            <span style="font-weight: bold; font-size: 20px; color: #0f172a;">${fromName}</span>
          </div>
          ${contentHtml}
          <div style="margin-top: 32px; border-top: 1px solid #e2e8f0; padding-top: 16px; font-size: 12px; color: #94a3b8; text-align: center;">
            © ${year} ${fromName}. All rights reserved.
          </div>
        </div>
      </body>
      </html>
    `;

    return { html: fullHtml, text: textFallback };
  }
}
