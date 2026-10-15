/* Shared field errors for desktop dialogs and mobile forms. */
window.FormValidation = (() => {
  let sequence = 0;
  const states = new WeakMap();
  function clear(container) {
    container.querySelectorAll('[data-validation-error]').forEach(error => {
      const control = [...container.querySelectorAll('[aria-describedby]')].find(input => input.getAttribute('aria-describedby').split(/\s+/).includes(error.id));
      if (control) {
        const remaining = control.getAttribute('aria-describedby').split(/\s+/).filter(id => id !== error.id).join(' ');
        if (remaining) control.setAttribute('aria-describedby', remaining); else control.removeAttribute('aria-describedby');
        control.removeAttribute('aria-invalid');
      }
      error.remove();
    });
    const state = states.get(container);
    if (state) { state.errors = []; state.summary.hidden = true; }
  }
  function render(state) {
    const { container, summary, errors } = state;
    clear(container);
    state.errors = errors;
    summary.replaceChildren();
    summary.hidden = !errors.length;
    summary.classList.toggle('hidden', !errors.length);
    if (!errors.length) return;
    summary.setAttribute('role', 'alert'); summary.tabIndex = -1;
    const heading = document.createElement('p');
    heading.textContent = `Please correct ${errors.length === 1 ? 'this field' : 'these ' + errors.length + ' fields'}:`;
    summary.appendChild(heading);
    const list = document.createElement('ul');
    summary.appendChild(list);
    errors.forEach(({ control, message }) => {
      const note = document.createElement('p');
      note.id = `form-validation-${++sequence}`;
      note.dataset.validationError = ''; note.className = 'validation-field-error'; note.textContent = message;
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), note.id].filter(Boolean).join(' '));
      const wrapper = control.closest('[data-validation-field]');
      if (wrapper) wrapper.appendChild(note); else control.insertAdjacentElement('afterend', note);
      const item = document.createElement('li'), link = document.createElement('button');
      link.type = 'button'; link.className = 'validation-error-link'; link.textContent = message;
      link.onclick = () => { control.dispatchEvent(new CustomEvent('validationfocus', { bubbles: true })); control.closest('[hidden]')?.removeAttribute('hidden'); const details = control.closest('details'); if (details) details.open = true; control.focus(); };
      item.appendChild(link); list.appendChild(item);
    });
  }
  function show(container, errors, summary) {
    let state = states.get(container);
    if (!state) {
      state = { container, errors: [], summary };
      states.set(container, state);
      const update = event => {
        if (!state.errors.some(error => error.control === event.target)) return;
        const remaining = state.errors.filter(error => error.control !== event.target || !(error.isValid ? error.isValid() : error.control.validity.valid && (error.control.type === 'checkbox' ? error.control.checked : error.control.value.trim())));
        if (remaining.length !== state.errors.length) { state.errors = remaining; render(state); }
      };
      container.addEventListener('input', update); container.addEventListener('change', update);
    }
    state.summary = summary; state.errors = errors;
    render(state);
    if (errors.length) summary.focus();
    return !errors.length;
  }
  return { show, clear };
})();
