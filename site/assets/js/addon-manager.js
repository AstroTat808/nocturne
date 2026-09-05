(() => {
  const form = document.querySelector('.addon-manager-form');
  if (!form) return;
  const choices = [...form.querySelectorAll('[data-addon-choice]')];
  const total = form.querySelector('[data-addon-total]');
  const count = form.querySelector('[data-addon-count]');
  const submit = form.querySelector('button[type="submit"]');
  const policy = form.querySelector('input[name="package_policy"]');
  const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);

  function sync() {
    let cents = 0;
    let selected = 0;
    for (const choice of choices) {
      const input = choice.querySelector('input[type="checkbox"]');
      const on = Boolean(input?.checked);
      choice.classList.toggle('is-selected', on);
      if (!on) continue;
      selected += 1;
      cents += Number(choice.dataset.priceCents || 0);
    }
    if (total) total.textContent = money(cents);
    if (count) count.textContent = selected ? `${selected} selected` : 'Nothing selected yet';
    if (submit) {
      const shouldDisable = selected === 0 || Boolean(policy && !policy.checked);
      if (submit.disabled !== shouldDisable) submit.disabled = shouldDisable;
    }
  }

  for (const choice of choices) choice.querySelector('input[type="checkbox"]')?.addEventListener('change', sync);
  policy?.addEventListener('change', sync);
  sync();
})();
