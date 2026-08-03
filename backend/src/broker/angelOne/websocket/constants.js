"use strict";

module.exports = {

    ACTION: {

        SUBSCRIBE: 1,

        UNSUBSCRIBE: 0

    },

    MODE: {

        LTP: 1,

        QUOTE: 2,

        SNAP_QUOTE: 3,

        DEPTH: 4

    },

    EXCHANGE: {

        BSE: 1,

        NSE: 2,

        NFO: 3,

        MCX: 5,

        NCDEX: 7,

        CDE: 13

    },

    HEARTBEAT_INTERVAL: 10000,

    MAX_RECONNECTS: Infinity,

    RECONNECT_DELAY: 3000

};