# Valmar Email Service

A complete email service for handling credit card processing receipts and sales outbound communications.

## Features

- **Credit Card Processing Receipts** - Automated email confirmations for payment transactions
- **Sales Emails** - Bulk outbound email campaigns for business development
- **Bulk Email Support** - Send multiple emails in a single request
- **Multiple Email Providers** - Supports local SMTP, SendGrid, or test accounts
- **Beautiful HTML Templates** - Professional receipt and sales email templates

## Quick Start

### 1. Configuration

Add email settings to your `.env` file. By default, the service uses **Ethereal Email** (a free test account) if nothing is configured:

```env
# Leave blank to use Ethereal test account (default)
# SMTP_HOST=
# SMTP_PORT=
# SMTP_SECURE=
# SMTP_USER=
# SMTP_PASSWORD=
# SENDGRID_API_KEY=

EMAIL_FROM=noreply@valmar.local
```

### 2. Start the Server

```bash
npm start
```

You'll see:
```
Email service initialized with Ethereal (test account)
Test inbox: https://ethereal.email/messages
```

## API Endpoints

### Send Credit Card Receipt

**POST** `/api/send-receipt`

Sends a formatted payment receipt email.

```json
{
  "to": "customer@example.com",
  "customerName": "John Doe",
  "amount": "1234.56",
  "cardLast4": "4242",
  "transactionId": "TXN-12345",
  "timestamp": "2026-10-02T15:30:00.000Z"
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "<message-id@ethereal.email>"
}
```

### Send Sales Email

**POST** `/api/send-sales-email`

Sends an outbound sales/business development email.

```json
{
  "to": "prospect@company.com",
  "subject": "Lower Your Processing Fees Today",
  "body": "<p>Hi there,</p><p>We can help your business...</p>",
  "businessName": "Acme Corp",
  "offerDetails": {
    "Processing Rate": "1.99%",
    "Monthly Fee": "Waived first 3 months",
    "Setup Time": "Same day approval"
  }
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "<message-id@ethereal.email>"
}
```

### Send Bulk Emails

**POST** `/api/send-bulk-emails`

Send multiple emails in one request.

```json
{
  "emails": [
    {
      "to": "customer1@example.com",
      "customerName": "Customer One",
      "amount": "500.00",
      "cardLast4": "1111",
      "transactionId": "TXN-001"
    },
    {
      "to": "customer2@example.com",
      "customerName": "Customer Two",
      "amount": "750.50",
      "cardLast4": "2222",
      "transactionId": "TXN-002"
    }
  ],
  "template": {
    "type": "credit-card"
  }
}
```

**Response:**
```json
{
  "success": true,
  "total": 2,
  "successful": 2,
  "failed": 0,
  "results": [
    { "email": "customer1@example.com", "success": true, "messageId": "..." },
    { "email": "customer2@example.com", "success": true, "messageId": "..." }
  ]
}
```

## Configuration Options

### Option 1: Ethereal Email (Default - Free Testing)

No configuration needed! The service automatically creates a test account.

Perfect for development. Visit https://ethereal.email/messages to view sent emails.

### Option 2: Custom SMTP Server

```env
SMTP_HOST=smtp.yourmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@yourdomain.com
SMTP_PASSWORD=your-password
EMAIL_FROM=noreply@yourdomain.com
```

### Option 3: SendGrid

```env
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=noreply@yourdomain.com
```

Install SendGrid transport:
```bash
npm install nodemailer-sendgrid-transport
```

## Testing

### Using the Test Script

```bash
# Send test receipt
node scripts/test-email.js receipt test@example.com

# Send test sales email
node scripts/test-email.js sales prospect@example.com

# Send bulk test emails
node scripts/test-email.js bulk
```

### Using curl

```bash
# Send a receipt
curl -X POST http://localhost:3003/api/send-receipt \
  -H "Content-Type: application/json" \
  -d '{
    "to": "customer@example.com",
    "customerName": "John Doe",
    "amount": "1234.56",
    "cardLast4": "4242",
    "transactionId": "TXN-12345"
  }'
```

### Integrating with Your Bot

In your Claude integration or call handlers:

```javascript
const axios = require('axios');

async function sendPaymentReceipt(to, amount, cardLast4, transactionId) {
  try {
    const response = await axios.post('http://localhost:3003/api/send-receipt', {
      to,
      customerName: 'Customer', // Get from call data
      amount: String(amount),
      cardLast4,
      transactionId,
    });
    console.log('Receipt sent:', response.data.messageId);
  } catch (error) {
    console.error('Failed to send receipt:', error.message);
  }
}
```

## Email Templates

### Credit Card Receipt

Includes:
- Transaction ID
- Amount (formatted currency)
- Last 4 digits of card
- Processing timestamp
- Professional header/footer

### Sales Email

Includes:
- Custom subject line
- HTML body content
- Offer details (highlighted in a box)
- Call-to-action styling
- Professional branding

## Best Practices

1. **Always validate email addresses** before sending
2. **Track message IDs** for bounce/delivery monitoring
3. **Use bulk endpoints** for multiple recipients to avoid rate limits
4. **Monitor Ethereal inbox** during development at https://ethereal.email
5. **Set appropriate EMAIL_FROM** to avoid spam filters
6. **Test with real email provider** before production deployment

## Troubleshooting

### "Email service not initialized"

The email service failed to start. Check:
- Your .env file is valid
- SMTP credentials are correct
- SENDGRID_API_KEY is valid
- Network connection to email provider

### Emails in Ethereal but not arriving elsewhere

The SMTP credentials may be incorrect. Verify:
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
- Check firewall/network access to SMTP server
- Verify authentication method (may need TLS/SSL flags)

### High bounce rate

Check:
- EMAIL_FROM is a valid sender address
- Email addresses are properly formatted
- Not sending to known spam traps
- DKIM/SPF records configured (for custom SMTP)

## File Structure

```
valmar-bot/
├── lib/
│   └── email.js              # Email service module
├── scripts/
│   └── test-email.js         # Testing script
├── EMAIL_SERVICE.md          # This file
├── server.js                 # Main server (with email endpoints)
└── .env.example              # Example configuration
```

## Next Steps

1. Configure your preferred email provider in `.env`
2. Test with `node scripts/test-email.js receipt test@example.com`
3. Integrate email sending into your call handlers
4. Monitor delivery and adjust templates as needed
