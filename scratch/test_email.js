const nodemailer = require('nodemailer');

async function main() {
  const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
      user: 'support@bwscan.io',
      pass: 'Tayyab@5588'
    }
  });

  try {
    const info = await transporter.sendMail({
      from: '"HRMS Platform" <nsupport@bwscan.io>',
      to: 'codefinitywithdev@gmail.com',
      subject: 'Test Email from HRMS Platform',
      text: 'Testing SMTP connection from HRMS backend',
      html: '<b>Testing SMTP connection from HRMS backend</b>'
    });
    console.log('Email sent successfully! Message ID:', info.messageId);
  } catch (err) {
    console.error('Send failed:', err.message);
  }
}

main();
