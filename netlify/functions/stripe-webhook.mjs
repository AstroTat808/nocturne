import stripeWebhookCore from './stripe-webhook-core.mjs';

const POLICY_TEXT = 'FINAL SALE / NON-REFUNDABLE: NOCTURNE drink packages cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash, including unused or unredeemed benefits.';
const POLICY_HTML = `<p style="margin:20px 0;color:#ffca61;font-size:12px;line-height:1.7"><strong>FINAL SALE / NON-REFUNDABLE:</strong> NOCTURNE drink packages cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash, including unused or unredeemed benefits.</p>`;

function receiptNeedsPolicy(message) {
  const subject = String(message?.subject || '');
  const text = String(message?.text || '');
  if (subject === 'Your NOCTURNE Drink Package Is Confirmed') return true;
  if (subject === 'Your NOCTURNE Ticket Is Confirmed' && /Drink package:/i.test(text)) return true;
  return false;
}

function addPolicy(message) {
  if (!receiptNeedsPolicy(message)) return message;
  const text = String(message.text || '');
  const html = String(message.html || '');
  return {
    ...message,
    text: text.includes('FINAL SALE / NON-REFUNDABLE') ? text : `${text}\n\n${POLICY_TEXT}`,
    html: html.includes('FINAL SALE / NON-REFUNDABLE') ? html : html.replace('</div></div></body></html>', `${POLICY_HTML}</div></div></body></html>`)
  };
}

export default async (req) => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url === 'https://api.resend.com/emails' && typeof init?.body === 'string') {
      try {
        const message = JSON.parse(init.body);
        const next = addPolicy(message);
        if (next !== message || next.text !== message.text || next.html !== message.html) {
          init = { ...init, body: JSON.stringify(next) };
        }
      } catch {}
    }
    return priorFetch(input, init);
  };

  try {
    return await stripeWebhookCore(req);
  } finally {
    globalThis.fetch = priorFetch;
  }
};
