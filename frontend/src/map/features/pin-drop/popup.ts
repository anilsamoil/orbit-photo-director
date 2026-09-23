import { validatePersonalTargetInput } from '../../../profile';
import { handleAdd } from '../../../profile-crud';

export function coordTargetName(lat: number, lon: number, precision: number): string {
  const latStr = `${Math.abs(lat).toFixed(precision)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(precision)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lonStr}`;
}

export function buildPinAddFooter(
  pinLat: number,
  pinLon: number,
  precision: number,
  profileName: string,
  onAdded: () => void,
  addFn: typeof handleAdd = handleAdd,
): HTMLElement {
  const footer = document.createElement('div');
  footer.className = 'pin-add-footer';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'pin-add-button';
  addBtn.textContent = '➕ Add to my targets';
  footer.appendChild(addBtn);

  addBtn.addEventListener('click', () => {
    addBtn.remove();
    const form = document.createElement('div');
    form.className = 'pin-add-form';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pin-add-name';
    input.maxLength = 200;
    input.value = coordTargetName(pinLat, pinLon, precision);
    input.setAttribute('aria-label', 'Target name');

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'pin-add-save';
    save.textContent = 'Save';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pin-add-cancel';
    cancel.textContent = 'Cancel';

    const err = document.createElement('div');
    err.className = 'pin-add-error';
    err.hidden = true;

    form.append(input, save, cancel, err);
    footer.appendChild(form);
    input.focus();
    input.select();

    cancel.addEventListener('click', () => {
      form.remove();
      footer.appendChild(addBtn);
    });

    const submit = async (): Promise<void> => {
      const name = input.value.trim() || coordTargetName(pinLat, pinLon, precision);
      const validated = validatePersonalTargetInput({
        profileName, name, lat: pinLat, lon: pinLon,
      });
      if (!validated.ok) {
        err.textContent = validated.error === 'name_too_long'
          ? 'Name too long (200 characters max).'
          : `Could not save: ${validated.error}`;
        err.hidden = false;
        return;
      }
      save.disabled = true;
      save.textContent = 'Saving…';
      const result = await addFn(profileName, validated.target);
      if (result === 'ok') {
        onAdded();
        return;
      }
      err.textContent = result;
      err.hidden = false;
      save.disabled = false;
      save.textContent = 'Save';
    };
    save.addEventListener('click', () => { void submit(); });
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    });
  });

  return footer;
}
