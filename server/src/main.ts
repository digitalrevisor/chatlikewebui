import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
createApp(config).listen(config.port, () => console.log(`chatlikewebui on port ${config.port}, OpenWebUI ${config.openwebuiUrl}`));
