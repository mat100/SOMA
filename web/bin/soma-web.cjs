#!/usr/bin/env node
// Starts the SOMA web server (after `npm run build`). node-pty and dugite are the packages of app/, as on the desktop:
// they are found through NODE_PATH, the bundle itself stays free of absolute paths.
const path = require('node:path');
const Module = require('node:module');

const appModules = path.resolve(__dirname, '..', '..', 'app', 'node_modules');
process.env.NODE_PATH = [appModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
// Only for this process: terminals and agents inherit the environment and must not see the app's packages
if (process.env.NODE_PATH === appModules) delete process.env.NODE_PATH;
else process.env.NODE_PATH = process.env.NODE_PATH.split(path.delimiter).slice(1).join(path.delimiter);
require('../dist/server.js');
