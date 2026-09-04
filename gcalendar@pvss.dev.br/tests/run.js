#!/usr/bin/env -S gjs -m
/**
 * run.js — executa toda a suíte fora do GNOME Shell.
 *
 * Uso:  ./tests/run.sh      (ou  gjs -m tests/run.js  a partir da raiz)
 */
import './utils.test.js';
import './eventFormat.test.js';
import './errors.test.js';
import './calendarService.test.js';
import './eventStore.test.js';
import './monthLayout.test.js';
import './notificationRules.test.js';

import {run} from './harness.js';

const ok = await run();
imports.system.exit(ok ? 0 : 1);
