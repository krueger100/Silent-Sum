/**
 * The page PayMongo sends the browser to after checkout. The app has no URL scheme on purpose
 * (the calculator disguise), so this is a plain https page that says what happened and asks the
 * user to go back to the app. It names no product, carries no identifier, and echoes nothing
 * from the request: the outcome only selects one of three fixed sentences.
 */
type Outcome = 'success' | 'cancel' | 'neutral';

function outcomeFrom(value: unknown): Outcome {
  if (value === 'success') return 'success';
  if (value === 'cancel') return 'cancel';
  return 'neutral';
}

const COPY: Readonly<Record<Outcome, { title: string; body: string }>> = {
  success: {
    title: 'Thank you',
    body:
      'Your payment was received. Return to the app to continue; it updates on its own as soon ' +
      'as the payment is confirmed, which can take a moment.',
  },
  cancel: {
    title: 'Payment not completed',
    body:
      'The payment was not completed and nothing was charged. Return to the app to try again ' +
      'whenever you like.',
  },
  neutral: {
    title: 'All done here',
    body: 'Return to the app to continue.',
  },
};

export function renderReturnPage(outcome: unknown): string {
  const { title, body } = COPY[outcomeFrom(outcome)];
  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex, nofollow">\n' +
    `<title>${title}</title>\n` +
    '<style>\n' +
    'body{margin:0;background:#111827;color:#F9FAFB;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}\n' +
    'main{max-width:420px;background:#1F2937;border-radius:20px;padding:24px}\n' +
    'h1{font-size:22px;font-weight:600;margin:0 0 12px}\n' +
    'p{font-size:16px;line-height:22px;color:#9CA3AF;margin:0}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<main>\n' +
    `<h1>${title}</h1>\n` +
    `<p>${body}</p>\n` +
    '</main>\n' +
    '</body>\n' +
    '</html>\n'
  );
}
