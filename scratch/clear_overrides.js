const db = require('../db/db');

// Clear static manual overrides so charges and MTF interest calculate 100% AUTOMATICALLY
db.prepare('DELETE FROM broker_overrides').run();

console.log('SUCCESSFULLY CLEARED BROKER OVERRIDES - SYSTEM IS NOW 100% AUTOMATIC');
