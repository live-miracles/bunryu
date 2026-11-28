// Applies the theme before first paint: the stored choice, else dark (see theme.ts). Loaded
// as a plain, blocking script in the <head> of both pages, so the page does not flash; it
// is a file, not inline, because the Content-Security-Policy allows no inline script.
(() => {
    let stored: string | null = null;
    try {
        stored = localStorage.getItem('bunryu.theme');
    } catch {
        // Storage blocked: dark.
    }
    document.documentElement.dataset.theme = stored === 'light' ? 'light' : 'dark';
})();
