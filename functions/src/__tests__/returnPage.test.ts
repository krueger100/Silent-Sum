import { renderReturnPage } from '../returnPage';

describe('renderReturnPage', () => {
  it('thanks a successful payment and tells the user to go back to the app', () => {
    const html = renderReturnPage('success');
    expect(html).toContain('<!doctype html>');
    expect(html).toMatch(/payment was received/i);
    expect(html).toMatch(/return to the app/i);
  });

  it('says nothing was charged on a cancelled checkout', () => {
    const html = renderReturnPage('cancel');
    expect(html).toMatch(/not completed/i);
    expect(html).toMatch(/nothing was charged/i);
  });

  it('stays neutral for anything else and never echoes the query', () => {
    const html = renderReturnPage('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).toMatch(/return to the app/i);
  });

  it('carries no product name, no identifiers and asks not to be indexed', () => {
    for (const outcome of ['success', 'cancel', undefined]) {
      const html = renderReturnPage(outcome);
      expect(html).not.toMatch(/silentsum/i);
      expect(html).not.toMatch(/vault/i);
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    }
  });
});
