#!/usr/bin/env node

/**
 * Test script for email service
 * Run: node scripts/test-email.js [type] [email]
 *
 * Types: receipt, sales, bulk
 * Example: node scripts/test-email.js receipt customer@example.com
 */

require('dotenv').config();
const { initEmailService, sendCreditCardReceipt, sendSalesEmail, sendBulkEmails } = require('../lib/email');

async function main() {
  const [type = 'receipt', email = 'test@example.com'] = process.argv.slice(2);

  console.log(`Initializing email service...`);
  await initEmailService();

  try {
    if (type === 'receipt') {
      console.log(`\nSending credit card receipt to ${email}...`);
      const result = await sendCreditCardReceipt({
        to: email,
        customerName: 'John Doe',
        amount: '1,234.56',
        cardLast4: '4242',
        transactionId: 'TXN-' + Date.now(),
      });
      console.log('✓ Receipt sent!');
      console.log(`Message ID: ${result.messageId}`);
      if (result.response && result.response.includes('ethereal')) {
        console.log(`Preview: ${result.response}`);
      }
    } else if (type === 'sales') {
      console.log(`\nSending sales email to ${email}...`);
      const result = await sendSalesEmail({
        to: email,
        subject: 'Exclusive Offer: Lower Your Processing Fees Today',
        body: `
          <p>Hi there,</p>
          <p>We're reaching out because we noticed your business could benefit from our competitive merchant processing rates.</p>
          <p>With Valmar Merchant Services, you'll get:</p>
          <ul>
            <li>Lower processing fees</li>
            <li>24/7 dedicated support</li>
            <li>Fast settlement times</li>
          </ul>
          <p>Let's talk about how we can help your business grow!</p>
        `,
        businessName: 'Your Business',
        offerDetails: {
          'Processing Rate': '1.99%',
          'Monthly Fee': 'Waived first 3 months',
          'Setup Time': 'Same day approval',
        },
      });
      console.log('✓ Sales email sent!');
      console.log(`Message ID: ${result.messageId}`);
    } else if (type === 'bulk') {
      console.log(`\nSending bulk emails...`);
      const emails = [
        {
          to: 'customer1@example.com',
          customerName: 'Customer One',
          amount: '500.00',
          cardLast4: '1111',
          transactionId: 'TXN-001',
        },
        {
          to: 'customer2@example.com',
          customerName: 'Customer Two',
          amount: '750.50',
          cardLast4: '2222',
          transactionId: 'TXN-002',
        },
      ];
      const results = await sendBulkEmails(emails, { type: 'credit-card' });
      console.log(`✓ Bulk emails sent!`);
      console.log(`Successful: ${results.filter(r => r.success).length}/${results.length}`);
      results.forEach(r => {
        const status = r.success ? '✓' : '✗';
        console.log(`  ${status} ${r.email}: ${r.messageId || r.error}`);
      });
    } else {
      console.log(`Unknown type: ${type}`);
      console.log(`\nUsage: node scripts/test-email.js [receipt|sales|bulk] [email]`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main().catch(console.error);
