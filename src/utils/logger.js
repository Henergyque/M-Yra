import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.resolve(__dirname, '../../logs');

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  CRITICAL: 4
};

const LOG_COLORS = {
  DEBUG: '\x1b[36m',    // Cyan
  INFO: '\x1b[32m',     // Green
  WARN: '\x1b[33m',     // Yellow
  ERROR: '\x1b[31m',    // Red
  CRITICAL: '\x1b[35m'  // Magenta
};

const RESET = '\x1b[0m';

export class Logger {
  constructor(name, minLevel = 'INFO') {
    this.name = name;
    this.minLevel = LOG_LEVELS[minLevel];
    this.logFile = path.join(logsDir, `${name}-${new Date().toISOString().split('T')[0]}.log`);
    this.writeQueue = Promise.resolve();
  }

  log(level, message, data = {}) {
    const levelValue = LOG_LEVELS[level];
    if (levelValue < this.minLevel) return; // Skip if below threshold

    const timestamp = new Date().toISOString();
    const emoji = {
      DEBUG: '🔧',
      INFO: 'ℹ️',
      WARN: '⚠️',
      ERROR: '❌',
      CRITICAL: '🔴'
    };

    const logEntry = {
      timestamp,
      level,
      module: this.name,
      message,
      ...(Object.keys(data).length > 0 && { data })
    };

    // Console output with colors
    const color = LOG_COLORS[level] || '';
    const consoleMsg = `${emoji[level]} ${color}[${level}]${RESET} [${this.name}] ${message}`;
    
    if (level === 'ERROR' || level === 'CRITICAL') {
      console.error(consoleMsg);
      if (Object.keys(data).length > 0) console.error(data);
    } else {
      console.log(consoleMsg);
      if (Object.keys(data).length > 0) console.log(data);
    }

    // File output (JSON format for easy parsing)
    const fileEntry = JSON.stringify(logEntry) + '\n';
    this.enqueueWrite(fileEntry);
  }

  enqueueWrite(entry) {
    this.writeQueue = this.writeQueue
      .then(() => fs.promises.appendFile(this.logFile, entry))
      .catch(err => {
        console.error('Failed to write log file:', err.message);
      });
  }

  debug(msg, data) { this.log('DEBUG', msg, data); }
  info(msg, data) { this.log('INFO', msg, data); }
  warn(msg, data) { this.log('WARN', msg, data); }
  error(msg, data) { this.log('ERROR', msg, data); }
  critical(msg, data) { this.log('CRITICAL', msg, data); }

  // Performance tracking
  time(label) {
    this.timers = this.timers || {};
    this.timers[label] = Date.now();
  }

  timeEnd(label) {
    if (!this.timers || !this.timers[label]) return;
    const elapsed = Date.now() - this.timers[label];
    this.debug(`⏱️ ${label}`, { elapsedMs: elapsed });
    delete this.timers[label];
  }
}
