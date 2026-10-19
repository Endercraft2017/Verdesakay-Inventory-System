/* Shared sign-in controls; native inputs keep autofill and password-manager support. */
window.AuthControls = (function () {
    function errorMessage(error) { return error.offline ? 'You appear to be offline. Reconnect and try again. Your details are still here.' : error.message || 'Could not complete this request. Try again.'; }
    function passwords(root) {
        root.querySelectorAll('input[type=password]').forEach(input => {
            if (input.dataset.visibilityReady)
                return;
            input.dataset.visibilityReady = 'true';
            const row = document.createElement('div');
            row.className = 'auth-password-row';
            input.before(row);
            row.appendChild(input);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'auth-toggle';
            const label = input.dataset.label || 'password';
            function update() { const shown = input.type === 'text'; button.textContent = shown ? 'Hide' : 'Show'; button.setAttribute('aria-label', (shown ? 'Hide ' : 'Show ') + label); button.setAttribute('aria-pressed', String(shown)); }
            button.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; update(); });
            input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
            update();
            row.appendChild(button);
        });
    }
    return { passwords, errorMessage };
})();
