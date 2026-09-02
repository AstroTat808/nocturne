(() => {
  const packageBoxes = [
    document.querySelector('input[name="drink_package"]'),
    document.querySelector('input[name="water_package"]'),
    document.querySelector('input[name="late_stay"]')
  ].filter(Boolean);
  const policyBox = document.querySelector('input[name="package_policy"]');

  if (!policyBox || !packageBoxes.length) return;

  const sync = () => {
    const anySelected = packageBoxes.some((box) => box.checked && !box.disabled);
    policyBox.disabled = !anySelected;
    policyBox.required = anySelected;
    if (!anySelected) policyBox.checked = false;
  };

  for (const packageBox of packageBoxes) packageBox.addEventListener('change', sync);
  sync();
})();
