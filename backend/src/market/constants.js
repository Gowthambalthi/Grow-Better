"use strict";

/*
|--------------------------------------------------------------------------
| Exchanges
|--------------------------------------------------------------------------
*/

const EXCHANGE = Object.freeze({

    NSE: "NSE",

    BSE: "BSE",

    MCX: "MCX"

});


/*
|--------------------------------------------------------------------------
| Segments
|--------------------------------------------------------------------------
*/

const SEGMENT = Object.freeze({

    CASH: "CASH",

    FNO: "FNO",

    COMMODITY: "COMMODITY"

});


/*
|--------------------------------------------------------------------------
| Events
|--------------------------------------------------------------------------
*/

const EVENTS = Object.freeze({

    CONNECT: "connect",

    DISCONNECT: "disconnect",

    RECONNECT: "reconnect",

    TICK: "tick",

    ERROR: "error"

});


/*
|--------------------------------------------------------------------------
| Default Index Watchlist
|--------------------------------------------------------------------------
*/

const DEFAULT_INDICES = Object.freeze([

    "NIFTY",

    "BANKNIFTY",

    "FINNIFTY",

    "MIDCPNIFTY",

    "SENSEX"

]);


/*
|--------------------------------------------------------------------------
| Default Commodity Watchlist
|--------------------------------------------------------------------------
*/

const DEFAULT_COMMODITIES = Object.freeze([

    "GOLD",

    "SILVER",

    "CRUDEOIL",

    "NATURALGAS",

    "COPPER"

]);


module.exports = {

    EXCHANGE,

    SEGMENT,

    EVENTS,

    DEFAULT_INDICES,

    DEFAULT_COMMODITIES

};