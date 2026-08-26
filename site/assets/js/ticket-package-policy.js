(() => {
  const pairs = [
    ['drink_package', 'drink_package_policy'],
    ['water_package', 'water_package_policy']
  ];

  for (const [packageName, policyName] of pairs) {
    const packageBox = document.querySelector(`input[name="${packageName}"]`);
    const policyBox = document.querySelector(`input[name="${policyName}"]`);
    if (!packageBox || !policyBox) continue;

    const sync = () => {
      policyBox.disabled = !packageBox.checked;
      policyBox.required = packageBox.checked;
      if (!packageBox.checked) policyBox.checked = false;
    };

    packageBox.addEventListener('change', sync);
    sync();
  }
})();
