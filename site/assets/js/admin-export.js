(() => {
  async function download(button, action, fallbackName) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparing…';
    try {
      const response = await fetch(`/api/admin/dashboard?action=${encodeURIComponent(action)}`, {
        credentials: 'same-origin',
        headers: { Accept: 'text/csv' }
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${response.status}).`);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || fallbackName;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      window.alert(error.message || 'The export could not be created.');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  const applications = document.querySelector('#admin-export-applications');
  const audit = document.querySelector('#admin-export-audit');
  const drinks = document.querySelector('#admin-export-drinks');
  applications?.addEventListener('click', () => download(applications, 'export-applications', 'nocturne-applications.csv'));
  audit?.addEventListener('click', () => download(audit, 'export-audit', 'nocturne-audit.csv'));
  drinks?.addEventListener('click', () => download(drinks, 'export-drink-redemptions', 'nocturne-drink-redemptions.csv'));
})();
