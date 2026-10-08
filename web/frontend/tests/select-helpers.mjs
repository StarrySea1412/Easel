import assert from 'node:assert/strict';
import { act } from 'react';

// Exercise the actual shared popup through its public combobox/listbox behavior.
export async function selectOption(trigger, value) {
  assert.ok(trigger, 'combobox exists');
  assert.equal(trigger.getAttribute('role'), 'combobox');
  await act(async () => { trigger.focus(); trigger.click(); });
  const popup = document.getElementById(trigger.getAttribute('aria-controls'));
  assert.ok(popup, 'custom listbox opens');
  const option = [...popup.querySelectorAll('[role="option"]')].find(item => item.dataset.value === value);
  assert.ok(option, `option ${value} exists`);
  await act(async () => option.click());
}

export async function optionValues(trigger) {
  await act(async () => trigger.click());
  const popup = document.getElementById(trigger.getAttribute('aria-controls'));
  assert.ok(popup, 'custom listbox opens');
  const values = [...popup.querySelectorAll('[role="option"]')].map(item => item.dataset.value);
  await act(async () => trigger.click());
  return values;
}
