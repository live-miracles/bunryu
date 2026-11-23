// Writes $REVIEW_DIR/catalog.json: the catalogue without its `apply` functions, for build_report.py.
import fs from 'node:fs';
import { catalog } from './scenarios.mts';

const dir = process.env.REVIEW_DIR ?? '/tmp/bunryu-message-review';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
    `${dir}/catalog.json`,
    JSON.stringify(
        catalog.map(({ apply: _apply, ...e }) => e),
        null,
        1,
    ),
);
