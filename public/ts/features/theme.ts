// The navbar's theme switch: System, Light or Dark. System leaves
// color-scheme to the browser (the CSS tokens are light-dark() pairs); the other two
// pin it through data-theme on <html>. The choice is per browser; the inline script in
// index.html's head applies it before first paint so the page does not flash.

type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'bunryu.theme';
const ORDER: ThemeChoice[] = ['system', 'light', 'dark'];
const LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

const ICON: Record<ThemeChoice, string> = {
    system: '<rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8M12 17v4" />',
    light: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />',
    dark: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />',
};

let choice: ThemeChoice = 'system';

function load(): void {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'light' || saved === 'dark') choice = saved;
    } catch {
        // Storage blocked: the choice lasts until the page is reloaded.
    }
}

function apply(): void {
    if (choice === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    try {
        if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
        // Storage blocked: see load().
    }
    syncButton();
}

function syncButton(): void {
    const group = document.getElementById('theme-switch');
    if (!group) return;
    group.innerHTML = ORDER.map((c) => {
        const active = c === choice;
        return `<button type="button" data-theme-choice="${c}" class="btn btn-square btn-xs join-item ${active ? 'btn-accent btn-soft' : 'opacity-70'}" aria-pressed="${active}" title="Theme: ${LABEL[c]}" aria-label="Theme: ${LABEL[c]}"><svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[c]}</svg></button>`;
    }).join('');
}

export function initTheme(): void {
    load();
    syncButton();
    document.getElementById('theme-switch')?.addEventListener('click', (e) => {
        const next = (e.target as Element).closest<HTMLElement>('[data-theme-choice]')?.dataset
            .themeChoice;
        if (next !== 'system' && next !== 'light' && next !== 'dark') return;
        choice = next;
        apply();
    });
}
