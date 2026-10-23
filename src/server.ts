import { createApp } from './app.js';
import { readConfig } from './config.js';

// NFR-008: a missing or malformed variable stops the process here, before anything listens.
const config = readConfig();

createApp().listen(config.PORT);
