(() => {
  const packageBox = document.querySelector('input[name="drink_package"]');
  const policyBox = document.querySelector('input[name="drink_package_policy"]');
  if (!packageBox || !policyBox) return;
  const sync = () => {
    policyBox.disabled = !packageBox.checked;
    policyBox.required = packageBox.checked;
    if (!packageBox.checked) policyBox.checked = false;
  };
  packageBox.addEventListener('change', sync);
  sync();
})();
