const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';

export async function sendOpsAlert(subject, lines = []) {
  const recipient = process.env.NOCTURNE_OPS_ALERT_TO || process.env.NOCTURNE_APPLICATION_NOTIFY_TO || '';
  if (!recipient || !process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) {
    return { sent: false, reason: 'Operations alerts are not configured.' };
  }

  const text = [
    'NOCTURNE operations alert',
    '',
    ...lines.map((line) => String(line).slice(0, 1000)),
    '',
    `Support: ${HELP_EMAIL}`
  ].join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.NOCTURNE_EMAIL_FROM,
      to: [recipient],
      subject: `[NOCTURNE] ${String(subject).slice(0, 140)}`,
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { sent: true, messageId: data.id || null };
}
