// The navbar's light/dark toggle. Until it is clicked the page follows the system (the CSS
// tokens are light-dark() pairs); a click pins the opposite of what is showing through
// data-theme on <html>, and the choice is kept per browser. The inline script in
// index.html's head applies a stored choice before first paint so the page does not flash.

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'bunryu.theme';

const ICON: Record<Theme, string> = {
    light: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />',
    dark: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />',
};

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function current(): Theme {
    const pinned = document.documentElement.dataset.theme;
    if (pinned === 'light' || pinned === 'dark') return pinned;
    return systemDark.matches ? 'dark' : 'light';
}

// The button shows the theme a click switches to: a sun in the dark, a moon in the light.
function syncButton(): void {
    const button = document.getElementById('theme-btn');
    if (!button) return;
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[next === 'light' ? 'light' : 'dark']}</svg>`;
    const label = `Switch to ${next} theme`;
    button.title = label;
    button.setAttribute('aria-label', label);
}

export function initTheme(): void {
    syncButton();
    // Not pinned: the icon has to follow the system when it changes.
    systemDark.addEventListener('change', syncButton);
    document.getElementById('theme-btn')?.addEventListener('click', () => {
        const next: Theme = current() === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // Storage blocked: the choice lasts until the page is reloaded.
        }
        syncButton();
    });
}
