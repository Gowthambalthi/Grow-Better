"use strict";

const MODE = {

    LTP: 1,

    QUOTE: 2,

    SNAP_QUOTE: 3,

    DEPTH: 4

};

const ACTION = {

    SUBSCRIBE: 1,

    UNSUBSCRIBE: 0

};

const EXCHANGE = {

    BSE: 1,

    NSE: 2,

    NFO: 3,

    MCX: 5,

    NCDEX: 7,

    CDE: 13

};

module.exports = {

    MODE,

    ACTION,

    EXCHANGE

};