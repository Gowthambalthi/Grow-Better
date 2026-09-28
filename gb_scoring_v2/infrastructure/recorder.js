const fs = require('fs');
const path = require('path');

class Recorder {
    constructor() {
        const dateStr = new Date().toISOString().split('T')[0];
        const sessionDir = path.join(__dirname, '..', '..', 'data', 'v2_sessions');
        this.logFile = path.join(sessionDir, `session_${dateStr}_${Date.now()}.jsonl`);
        
        // Ensure data directory exists
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
    }

    log(stage, data) {
        const entry = JSON.stringify({ 
            timestamp: Date.now(), 
            stage, 
            data 
        }) + '\n';
        
        // Asynchronous, non-blocking append
        fs.appendFile(this.logFile, entry, err => {
            if (err) console.error('[Recorder] Write failed', err);
        });
    }
}

module.exports = new Recorder();
