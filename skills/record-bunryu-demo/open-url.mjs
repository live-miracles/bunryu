// A tiny Electron "app" that opens the dashboard. Pass it to the recorder as
// `record.mjs --app open-url.mjs`: `--url` together with the other recorder flags makes
// Electron exit with -1 before it starts on Windows.
import { app, BrowserWindow } from 'electron';

app.whenReady().then(() => {
    const win = new BrowserWindow({ width: 1280, height: 800, show: true });
    win.setMenuBarVisibility(false);
    win.loadURL(process.env.DEMO_URL ?? 'http://localhost:8080');
});
