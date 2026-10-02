const nodemailer = require('nodemailer');

let transporter = null;

async function initEmailService() {
  // Configure email service
  // For local development, use a test account from Ethereal
  // For production, use your SMTP credentials from .env

  if (process.env.SMTP_HOST) {
    // Use custom SMTP server from environment
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      } : undefined,
    });
    console.log(`Email service initialized with SMTP: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
  } else if (process.env.SENDGRID_API_KEY) {
    // Use SendGrid
    try {
      const sgTransport = require('nodemailer-sendgrid-transport');
      transporter = nodemailer.createTransport(sgTransport({
        auth: {
          api_key: process.env.SENDGRID_API_KEY,
        },
      }));
      console.log('Email service initialized with SendGrid');
    } catch (err) {
      console.warn('SendGrid API key set but transport not installed. Install with: npm install nodemailer-sendgrid-transport');
      console.warn('Falling back to Ethereal test account');
      // Fall through to Ethereal setup below
    }
  }

  if (!transporter) {
    // Use Ethereal Email for testing (creates a test inbox)
    try {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      console.log('Email service initialized with Ethereal (test account)');
      console.log(`Test inbox: https://ethereal.email/messages`);
      console.log(`Test credentials: ${testAccount.user} / ${testAccount.pass}`);
    } catch (err) {
      console.warn('Could not create test email account:', err.message);
      transporter = null;
    }
  }

  return transporter;
}

async function sendCreditCardReceipt(emailData) {
  if (!transporter) throw new Error('Email service not initialized');

  const {
    to,
    customerName,
    amount,
    cardLast4,
    transactionId,
    timestamp = new Date().toISOString(),
  } = emailData;

  const mailOptions = {
    from: process.env.EMAIL_FROM || 'noreply@valmar.local',
    to,
    subject: `Credit Card Processing Receipt - Transaction ${transactionId}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #2c3e50; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
          .content { border: 1px solid #ddd; padding: 20px; border-radius: 0 0 5px 5px; }
          .receipt-item { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
          .receipt-item:last-child { border-bottom: none; }
          .amount { font-size: 24px; font-weight: bold; color: #27ae60; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Payment Receipt</h1>
            <p>Valmar Merchant Services</p>
          </div>
          <div class="content">
            <p>Dear ${escapeHtml(customerName)},</p>
            <p>Thank you for your payment. Here's your receipt:</p>

            <div class="receipt-item">
              <span><strong>Transaction ID:</strong></span>
              <span>${escapeHtml(transactionId)}</span>
            </div>

            <div class="receipt-item">
              <span><strong>Amount:</strong></span>
              <span class="amount">$${parseFloat(amount).toFixed(2)}</span>
            </div>

            <div class="receipt-item">
              <span><strong>Card (Last 4):</strong></span>
              <span>****${escapeHtml(cardLast4)}</span>
            </div>

            <div class="receipt-item">
              <span><strong>Processed:</strong></span>
              <span>${new Date(timestamp).toLocaleString()}</span>
            </div>

            <div class="footer">
              <p>If you have any questions about this transaction, please contact our support team.</p>
              <p>&copy; ${new Date().getFullYear()} Valmar Merchant Services. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Payment Receipt
Transaction ID: ${transactionId}
Amount: $${parseFloat(amount).toFixed(2)}
Card: ****${cardLast4}
Processed: ${new Date(timestamp).toLocaleString()}

Thank you for your business!
Valmar Merchant Services
    `,
  };

  return transporter.sendMail(mailOptions);
}

async function sendSalesEmail(emailData) {
  if (!transporter) throw new Error('Email service not initialized');

  const {
    to,
    subject,
    body,
    businessName,
    offerDetails = {},
  } = emailData;

  const mailOptions = {
    from: process.env.EMAIL_FROM || 'sales@valmar.local',
    to,
    subject,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #2c3e50; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
          .content { border: 1px solid #ddd; padding: 20px; border-radius: 0 0 5px 5px; }
          .offer-box { background-color: #ecf0f1; padding: 15px; margin: 15px 0; border-left: 4px solid #27ae60; }
          .cta-button { display: inline-block; background-color: #3498db; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Business Opportunity</h1>
            <p>Valmar Merchant Services</p>
          </div>
          <div class="content">
            ${body}

            ${Object.keys(offerDetails).length > 0 ? `
            <div class="offer-box">
              <h3>Exclusive Offer:</h3>
              ${Object.entries(offerDetails)
                .map(([key, value]) => `<p><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(value))}</p>`)
                .join('')}
            </div>
            ` : ''}

            <div class="footer">
              <p>This email was sent because you may be interested in our services.</p>
              <p>Best regards,<br>The Valmar Team</p>
              <p>&copy; ${new Date().getFullYear()} Valmar Merchant Services. All rights reserved.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `,
    text: body,
  };

  return transporter.sendMail(mailOptions);
}

async function sendBulkEmails(emailList, template) {
  if (!transporter) throw new Error('Email service not initialized');

  const results = [];

  for (const email of emailList) {
    try {
      const result = template.type === 'credit-card'
        ? await sendCreditCardReceipt(email)
        : await sendSalesEmail(email);

      results.push({ email: email.to, success: true, messageId: result.messageId });
    } catch (err) {
      results.push({ email: email.to, success: false, error: err.message });
    }
  }

  return results;
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

module.exports = {
  initEmailService,
  sendCreditCardReceipt,
  sendSalesEmail,
  sendBulkEmails,
  getTransporter: () => transporter,
};
