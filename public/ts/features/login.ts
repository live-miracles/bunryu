// The login page: Enter or the button signs in, the eye button shows the password.

function togglePasswordVisibility(): void {
    const input = document.getElementById('password-input') as HTMLInputElement;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    document.getElementById('eye-icon')?.classList.toggle('hidden', show);
    document.getElementById('eye-off-icon')?.classList.toggle('hidden', !show);
}

async function login(): Promise<void> {
    const password = (document.getElementById('password-input') as HTMLInputElement).value;
    const btn = document.getElementById('login-btn') as HTMLButtonElement;
    const errorEl = document.getElementById('login-error') as HTMLElement;
    btn.disabled = true;
    errorEl.classList.add('hidden');
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        if (res.ok) {
            window.location.href = '/';
        } else {
            const data = (await res.json()) as { error?: string };
            errorEl.textContent = data.error || 'Login failed';
            errorEl.classList.remove('hidden');
        }
    } catch {
        errorEl.textContent = 'Request failed';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
    }
}

document.getElementById('password-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void login();
});
document.getElementById('password-toggle')?.addEventListener('click', togglePasswordVisibility);
document.getElementById('login-btn')?.addEventListener('click', () => void login());

export {};
